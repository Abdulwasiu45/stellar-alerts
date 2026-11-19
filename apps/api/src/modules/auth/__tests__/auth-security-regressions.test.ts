import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';

vi.hoisted(() => {
  process.env.MASTER_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
  process.env.MASTER_ENCRYPTION_KEY_VERSION = '1';
  process.env.JWT_SECRET = 'test-super-secret-jwt-key-12345';
  process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
});

const prismaMock = vi.hoisted(() => ({
  refreshSession: {
    findUnique: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  wallet: {
    findUnique: vi.fn(),
  },
}));

const sessionManagerMock = vi.hoisted(() => ({
  createSessionFamily: vi.fn(),
  rotateRefreshToken: vi.fn(),
  revokeFamily: vi.fn(),
}));

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: prismaMock,
}));

vi.mock('../../../lib/session-manager', () => sessionManagerMock);

vi.mock('../../../lib/redis', () => ({
  redis: redisMock,
}));

vi.mock('../../../lib/tokenBlocklist', () => ({
  revokeToken: vi.fn(),
  isTokenRevoked: vi.fn().mockResolvedValue(false),
}));

import { AuthService } from '../auth.service';
import { SEP10Service } from '../sep10.service';
import { AuthorizationError } from '../../../lib/errors';
import { encryptPersonalField } from '../../../utils/privacy';
import { stellarNetwork } from '../../../config/network';

describe('Auth & SEP-10 security regressions', () => {
  let authService: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    authService = new AuthService();
  });

  describe('AuthService.revokeSessionFamily IDOR protection', () => {
    it('rejects revoking a refresh session family owned by another user', async () => {
      prismaMock.refreshSession.findUnique.mockResolvedValueOnce({ userId: 'victim-user' });

      await expect(
        authService.revokeSessionFamily('family-victim', 'attacker-user', 'User logout'),
      ).rejects.toThrow(AuthorizationError);

      expect(sessionManagerMock.revokeFamily).not.toHaveBeenCalled();
    });

    it('rejects when session family does not exist for owner-checked revocation', async () => {
      prismaMock.refreshSession.findUnique.mockResolvedValueOnce(null);

      await expect(
        authService.revokeSessionFamily('missing-family', 'user-1', 'User logout'),
      ).rejects.toThrow(AuthorizationError);

      expect(sessionManagerMock.revokeFamily).not.toHaveBeenCalled();
    });

    it('revokes when session family belongs to the caller', async () => {
      prismaMock.refreshSession.findUnique.mockResolvedValueOnce({ userId: 'user-1' });

      await authService.revokeSessionFamily('family-1', 'user-1', 'User logout');

      expect(sessionManagerMock.revokeFamily).toHaveBeenCalledWith('family-1', 'User logout');
    });
  });

  describe('AuthService.getMe sanitization', () => {
    it('strips mfaSecret, excludes soft-deleted wallets, and masks telegram/whatsapp fields', async () => {
      const encryptedTelegram = encryptPersonalField('123456789');
      const encryptedWhatsapp = encryptPersonalField('+14155551234');

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        email: 'alice@example.com',
        mfaEnabled: true,
        mfaSecret: 'SUPER_SECRET_TOTP_BASE32',
        wallets: [
          { id: 'w-active', publicKey: 'GACTIVE', deletedAt: null },
          { id: 'w-deleted', publicKey: 'GDELETED', deletedAt: new Date('2026-01-01T00:00:00Z') },
        ],
        notifyPrefs: {
          id: 'np-1',
          userId: 'user-1',
          telegramChatId: encryptedTelegram,
          whatsappNumber: encryptedWhatsapp,
        },
      });

      const me = await authService.getMe('user-1');

      expect('mfaSecret' in me).toBe(false);
      expect(me.wallets).toHaveLength(1);
      expect(me.wallets[0].id).toBe('w-active');
      expect(me.notifyPrefs?.telegramChatId).toBe('tg:***6789');
      expect(me.notifyPrefs?.whatsappNumber).toBe('+1***1234');
    });
  });

  describe('SEP10Service replay & cross-account watch-only wallet hardening', () => {
    it('rejects replaying a signed SEP-10 challenge transaction', async () => {
      const serverKp = StellarSdk.Keypair.random();
      const clientKp = StellarSdk.Keypair.random();
      const sep10 = new SEP10Service(
        serverKp.secret(),
        undefined,
        stellarNetwork.networkPassphrase,
      );

      const { transaction: challengeXdr } = sep10.generateChallenge(clientKp.publicKey());
      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challengeXdr,
        stellarNetwork.networkPassphrase,
      ) as StellarSdk.Transaction;
      tx.sign(clientKp);
      const signedXdr = tx.toXDR();

      const expectedPlaceholder = `${clientKp.publicKey().substring(0, 12).toLowerCase()}@stellar-alerts.org`;
      prismaMock.wallet.findUnique.mockResolvedValue(null);
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'sep10-user-1',
        email: expectedPlaceholder,
      });

      const firstSession = await sep10.verifyAndIssueSession(signedXdr);
      expect(firstSession.token).toBeTruthy();

      await expect(sep10.verifyAndIssueSession(signedXdr)).rejects.toThrow(
        'Challenge transaction has already been used',
      );
    });

    it('never logs into a victim account when signing with a watch-only wallet key', async () => {
      const serverKp = StellarSdk.Keypair.random();
      const victimWatchedKp = StellarSdk.Keypair.random();
      const sep10 = new SEP10Service(
        serverKp.secret(),
        undefined,
        stellarNetwork.networkPassphrase,
      );

      const { transaction: challengeXdr } = sep10.generateChallenge(victimWatchedKp.publicKey());
      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challengeXdr,
        stellarNetwork.networkPassphrase,
      ) as StellarSdk.Transaction;
      tx.sign(victimWatchedKp);
      const signedXdr = tx.toXDR();

      // Victim registered victimWatchedKp as a watch-only wallet under victim@company.com
      prismaMock.wallet.findUnique.mockResolvedValueOnce({
        id: 'watch-wallet-1',
        publicKey: victimWatchedKp.publicKey(),
        deletedAt: null,
        user: {
          id: 'victim-user-id',
          email: 'victim@company.com',
        },
      });
      prismaMock.user.findUnique.mockResolvedValueOnce(null);
      prismaMock.user.create.mockResolvedValueOnce({
        id: 'isolated-sep10-user',
        email: `${victimWatchedKp.publicKey().substring(0, 12).toLowerCase()}@stellar-alerts.org`,
      });

      const session = await sep10.verifyAndIssueSession(signedXdr);

      expect(session.user.id).toBe('isolated-sep10-user');
      expect(session.user.id).not.toBe('victim-user-id');
      expect(session.user.email).toMatch(/@stellar-alerts\.org$/);
    });
  });
});
