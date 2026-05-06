#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Windy Chat — AWS EC2 Deployment Script
# ═══════════════════════════════════════════════════════════════════
#
# Deploys Windy Chat (Synapse + 8 microservices) to an AWS EC2 instance.
#
# Prerequisites:
#   - AWS CLI configured with appropriate IAM permissions
#   - SSH key pair created in the target region
#   - Domain DNS (chat.windychat.ai) pointing to an Elastic IP or ALB
#
# Usage:
#   ./deploy/aws-setup.sh                    # Interactive setup
#   ./deploy/aws-setup.sh --launch           # Launch EC2 + deploy
#   ./deploy/aws-setup.sh --deploy <host>    # Deploy to existing instance
#   ./deploy/aws-setup.sh --health <host>    # Health check all services
#
# Architecture:
#   EC2 (t3.medium+) running Docker Compose
#   ├── PostgreSQL 16 (EBS-backed volume for Synapse data)
#   ├── Redis 7 (in-memory, workers + OTP)
#   ├── Synapse (Matrix homeserver)
#   ├── Nginx (TLS termination + reverse proxy)
#   ├── Coturn (VoIP TURN/STUN)
#   └── 8 Node.js microservices (SQLite, EBS-backed volumes)
#
#   Cloudflare R2 for backup storage (via Windy Cloud API)
#   AWS ACM + ALB for TLS (alternative to certbot)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── Defaults ──
REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.medium}"
KEY_NAME="${AWS_KEY_NAME:-windy-chat-key}"
DOMAIN="${DOMAIN:-chat.windychat.ai}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@windyword.ai}"
SECURITY_GROUP_NAME="windy-chat-sg"
EBS_SIZE=50  # GB

# ═══════════════════════════════════════════════════════════════════
#  Functions
# ═══════════════════════════════════════════════════════════════════

print_banner() {
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Windy Chat — AWS Deployment${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════${NC}"
  echo ""
}

# ── Launch EC2 Instance ──
launch_instance() {
  echo -e "${BLUE}Launching EC2 instance...${NC}"
  echo "  Region: $REGION"
  echo "  Type:   $INSTANCE_TYPE"
  echo "  Key:    $KEY_NAME"
  echo ""

  # Get latest Amazon Linux 2023 AMI
  AMI_ID=$(aws ec2 describe-images \
    --region "$REGION" \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text 2>/dev/null)

  if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
    echo -e "${RED}Could not find Amazon Linux 2023 AMI in $REGION${NC}"
    exit 1
  fi
  echo "  AMI:    $AMI_ID"

  # Create security group
  SG_ID=$(aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=group-name,Values=$SECURITY_GROUP_NAME" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || echo "None")

  if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
    echo -e "${BLUE}Creating security group...${NC}"
    SG_ID=$(aws ec2 create-security-group \
      --region "$REGION" \
      --group-name "$SECURITY_GROUP_NAME" \
      --description "Windy Chat - Synapse + microservices" \
      --query 'GroupId' --output text)

    # Allow SSH, HTTP, HTTPS, TURN
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
      --ip-permissions \
        "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=0.0.0.0/0,Description=SSH}]" \
        "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTP}]" \
        "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTPS}]" \
        "IpProtocol=tcp,FromPort=3478,ToPort=3478,IpRanges=[{CidrIp=0.0.0.0/0,Description=TURN-TCP}]" \
        "IpProtocol=udp,FromPort=3478,ToPort=3478,IpRanges=[{CidrIp=0.0.0.0/0,Description=TURN-UDP}]" \
        "IpProtocol=tcp,FromPort=5349,ToPort=5349,IpRanges=[{CidrIp=0.0.0.0/0,Description=TURNS-TCP}]" \
        "IpProtocol=udp,FromPort=5349,ToPort=5349,IpRanges=[{CidrIp=0.0.0.0/0,Description=TURNS-UDP}]" \
        "IpProtocol=udp,FromPort=49152,ToPort=49200,IpRanges=[{CidrIp=0.0.0.0/0,Description=TURN-Media}]" \
      >/dev/null
    echo -e "  ${GREEN}Security group created: $SG_ID${NC}"
  else
    echo "  Security group exists: $SG_ID"
  fi

  # User data script — installs Docker and pulls the repo
  USER_DATA=$(cat <<'USERDATA'
#!/bin/bash
set -e

# Install Docker
dnf update -y
dnf install -y docker git
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# Install Docker Compose
DOCKER_CONFIG=/usr/local/lib/docker/cli-plugins
mkdir -p $DOCKER_CONFIG
curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o $DOCKER_CONFIG/docker-compose
chmod +x $DOCKER_CONFIG/docker-compose
ln -sf $DOCKER_CONFIG/docker-compose /usr/local/bin/docker-compose

# Install Node.js 22 (for running scripts)
dnf install -y nodejs22

# Create app directory
mkdir -p /opt/windy-chat
chown ec2-user:ec2-user /opt/windy-chat

echo "Windy Chat EC2 instance ready" > /opt/windy-chat/READY
USERDATA
)

  # Launch instance
  INSTANCE_ID=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$EBS_SIZE,\"VolumeType\":\"gp3\",\"Encrypted\":true}}]" \
    --user-data "$USER_DATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=windy-chat},{Key=Project,Value=windy-ecosystem}]" \
    --query 'Instances[0].InstanceId' --output text)

  echo -e "${GREEN}Instance launched: $INSTANCE_ID${NC}"

  # Wait for instance to be running
  echo "Waiting for instance to start..."
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

  # Get public IP
  PUBLIC_IP=$(aws ec2 describe-instances \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

  echo ""
  echo -e "${GREEN}Instance ready!${NC}"
  echo "  Instance ID: $INSTANCE_ID"
  echo "  Public IP:   $PUBLIC_IP"
  echo "  SSH:         ssh -i ~/.ssh/${KEY_NAME}.pem ec2-user@${PUBLIC_IP}"
  echo ""
  echo "  Next steps:"
  echo "    1. Point ${DOMAIN} DNS A record to ${PUBLIC_IP}"
  echo "    2. Wait ~2 minutes for user-data to complete"
  echo "    3. Run: $0 --deploy ${PUBLIC_IP}"
  echo ""
}

# ── Deploy to Instance ──
deploy_to_host() {
  local HOST="$1"
  echo -e "${BLUE}Deploying to ${HOST}...${NC}"

  # Rsync the repo (excluding node_modules, data, etc.)
  echo "  Syncing files..."
  rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude 'services/*/data' \
    --exclude 'services/*/node_modules' \
    --exclude '.env' \
    --exclude '.env.generated' \
    --exclude 'backups' \
    --exclude '.git' \
    -e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/${KEY_NAME}.pem" \
    "$ROOT_DIR/" "ec2-user@${HOST}:/opt/windy-chat/"

  # Run setup on the remote host
  echo "  Running remote setup..."
  ssh -o StrictHostKeyChecking=no -i "~/.ssh/${KEY_NAME}.pem" "ec2-user@${HOST}" bash <<REMOTE
set -e
cd /opt/windy-chat

# Generate .env if not exists
if [ ! -f .env ]; then
  echo "Generating credentials..."
  bash scripts/setup-credentials.sh
fi

# Install service dependencies
echo "Installing dependencies..."
for svc in shared onboarding directory push-gateway backup social translation media call-history; do
  (cd services/\$svc && npm ci --production 2>/dev/null) || true
done

# Build and start all services
echo "Starting services..."
docker compose pull
docker compose up -d --build

# Wait for services to start
echo "Waiting for services to start..."
sleep 15

# Setup TLS
if [ ! -f deploy/certs/fullchain.pem ]; then
  echo "Setting up TLS..."
  bash scripts/setup-tls.sh ${DOMAIN} ${CERTBOT_EMAIL} || echo "TLS setup deferred — configure DNS first"
fi

echo "Deployment complete!"
REMOTE

  echo ""
  echo -e "${GREEN}Deployment complete!${NC}"
  echo "  Host:    ${HOST}"
  echo "  Health:  Run $0 --health ${HOST}"
  echo ""
}

# ── Health Check ──
health_check() {
  local HOST="$1"
  local BASE="https://${DOMAIN}"
  local DIRECT="http://${HOST}"

  echo -e "${BLUE}Health checking ${HOST}...${NC}"
  echo ""

  local SERVICES=(
    "Synapse|${DIRECT}:8008/health"
    "Onboarding|${DIRECT}:8101/health"
    "Directory|${DIRECT}:8102/health"
    "Push Gateway|${DIRECT}:8103/health"
    "Backup|${DIRECT}:8104/health"
    "Social|${DIRECT}:8105/health"
    "Translation|${DIRECT}:8106/health"
    "Media|${DIRECT}:8107/health"
    "Call History|${DIRECT}:8108/health"
  )

  local PASS=0
  local FAIL=0

  for entry in "${SERVICES[@]}"; do
    IFS='|' read -r name url <<< "$entry"
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$url" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
      echo -e "  ${GREEN}✓${NC} ${name} (${STATUS})"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}✗${NC} ${name} (${STATUS})"
      FAIL=$((FAIL + 1))
    fi
  done

  # Check nginx/TLS if domain resolves
  NGINX_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${BASE}/.well-known/matrix/server" 2>/dev/null || echo "000")
  if [ "$NGINX_STATUS" = "200" ]; then
    echo -e "  ${GREEN}✓${NC} Nginx/TLS (${NGINX_STATUS})"
    PASS=$((PASS + 1))
  else
    echo -e "  ${YELLOW}○${NC} Nginx/TLS (${NGINX_STATUS}) — DNS may not be configured yet"
  fi

  echo ""
  echo -e "  ${GREEN}${PASS} healthy${NC}, ${RED}${FAIL} unhealthy${NC}"
  echo ""

  if [ "$FAIL" -gt 0 ]; then
    echo "  Troubleshooting:"
    echo "    ssh -i ~/.ssh/${KEY_NAME}.pem ec2-user@${HOST}"
    echo "    cd /opt/windy-chat && docker compose logs --tail=50"
    exit 1
  fi
}

# ═══════════════════════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════════════════════

print_banner

case "${1:-}" in
  --launch)
    launch_instance
    ;;
  --deploy)
    if [ -z "${2:-}" ]; then
      echo -e "${RED}Usage: $0 --deploy <host-ip>${NC}"
      exit 1
    fi
    deploy_to_host "$2"
    ;;
  --health)
    if [ -z "${2:-}" ]; then
      echo -e "${RED}Usage: $0 --health <host-ip>${NC}"
      exit 1
    fi
    health_check "$2"
    ;;
  *)
    echo "Usage:"
    echo "  $0 --launch           Launch a new EC2 instance"
    echo "  $0 --deploy <host>    Deploy to an existing instance"
    echo "  $0 --health <host>    Health check all services"
    echo ""
    echo "Environment variables:"
    echo "  AWS_REGION           AWS region (default: us-east-1)"
    echo "  INSTANCE_TYPE        EC2 instance type (default: t3.medium)"
    echo "  AWS_KEY_NAME         SSH key pair name (default: windy-chat-key)"
    echo "  DOMAIN               Domain name (default: chat.windychat.ai)"
    echo ""
    echo "Prerequisites:"
    echo "  1. AWS CLI configured: aws configure"
    echo "  2. SSH key pair created: aws ec2 create-key-pair --key-name windy-chat-key"
    echo "  3. Domain DNS configured to point to the instance IP"
    echo ""
    ;;
esac
