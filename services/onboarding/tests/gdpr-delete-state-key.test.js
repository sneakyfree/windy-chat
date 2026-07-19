/**
 * Q7 regression — DELETE /api/v1/onboarding/account must actually delete the
 * onboarding_state row (and thus reach the Matrix-deactivate branch). The bug
 * looked state up by windy_identity_id instead of the chat localpart, so the
 * row survived and Matrix was never deactivated.
 *
 * We assert the DB SIDE EFFECT (state row gone), NOT res.body.matrix_deactivated
 * — that field is stubbed true under NODE_ENV=test and would mask the bug.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.PORT = '0';
process.env.WINDY_JWT_SECRET = 'test-onboarding-secret';
process.env.NODE_ENV = 'test';

const { app } = require('../server');
const db = require('../lib/db');

const JWT_SECRET = process.env.WINDY_JWT_SECRET;

function tokenFor(windyId) {
  return jwt.sign(
    { sub: windyId, role: 'user', windy_identity_id: windyId },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

describe('GDPR delete removes onboarding_state by the correct (localpart) key', () => {
  it('deletes the state row keyed by chat_user_id, not windy_identity_id', () => {
    const windyId = `id_${Date.now()}`;
    const localpart = `grand.ma.${Date.now()}`;
    const now = new Date().toISOString();

    // Profile is keyed by chat_user_id and carries windy_identity_id.
    db.upsertProfile.run({
      chat_user_id: localpart,
      windy_identity_id: windyId,
      display_name: 'Grandma',
      languages: JSON.stringify(['en']),
      primary_language: 'en',
      avatar_url: null,
      created_at: now,
      onboarding_complete: 1,
    });
    // onboarding_state is keyed by windy_user_id = the localpart.
    db.upsertOnboardingState.run({
      windy_user_id: localpart,
      verified: 1,
      profile_setup: 1,
      matrix_provisioned: 1,
      matrix_user_id: `@${localpart}:chat.windypro.com`,
      provisioned_at: now,
      passport_id: null,
    });

    // Pre-condition: the row exists under the localpart key.
    expect(db.getOnboardingState.get(localpart)).toBeTruthy();

    return request(app)
      .delete('/api/v1/onboarding/account')
      .set('Authorization', `Bearer ${tokenFor(windyId)}`)
      .then((res) => {
        expect(res.status).toBe(200);
        // The real fix: the state row is gone. (Pre-fix this stayed present,
        // because the handler queried/deleted by windyId and found nothing.)
        expect(db.getOnboardingState.get(localpart)).toBeUndefined();
        expect(db.getProfileByWindyId.get(windyId)).toBeUndefined();
      });
  });
});
