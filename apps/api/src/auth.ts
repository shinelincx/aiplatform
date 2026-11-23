import {
  BadRequestException, Body, ConflictException, Controller, createParamDecorator, type CanActivate,
  type ExecutionContext, ForbiddenException, Get, Headers, HttpCode, Inject,
  Injectable, type OnApplicationBootstrap, Patch, Post, Delete, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Account, Session } from '@ado/shared';
import type { PoolClient } from 'pg';
import { Database, isUniqueViolation } from './database';
import { emailInput, objectInput, passwordInput, textInput } from './input';

const deriveKey = promisify(scrypt);
const sessionSeconds = 8 * 60 * 60;
const missingAccountHash = '00'.repeat(16) + ':' + '00'.repeat(64);
const accountColumns = 'id, email, name, system_role AS "systemRole", status';

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password: string, passwordHash: string) {
  const [salt, hex] = passwordHash.split(':');
  const expected = Buffer.from(hex, 'hex');
  const actual = await deriveKey(password, salt, 64) as Buffer;
  return timingSafeEqual(expected, actual);
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function sessionToken(authorization: string | undefined) {
  const token = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? '')?.[1];
  if (!token) throw new UnauthorizedException();
  return token;
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  constructor(@Inject(Database) private readonly db: Database) {}

  async onApplicationBootstrap() {
    const email = process.env.ADO_BOOTSTRAP_EMAIL;
    const password = process.env.ADO_BOOTSTRAP_PASSWORD;
    if (!email && !password) return;
    const values = [emailInput(email), await hashPassword(passwordInput(password))];
    await this.db.pool.query(
      `INSERT INTO users (email, name, password_hash, system_role)
       VALUES ($1, 'Administrator', $2, 'admin') ON CONFLICT (email) DO NOTHING`,
      values,
    );
  }

  async login(body: unknown): Promise<Session> {
    const input = objectInput(body);
    const email = emailInput(input.email);
    const password = passwordInput(input.password, 1);
    const { rows: [account] } = await this.db.pool.query<Account & { password_hash: string }>(
      `SELECT ${accountColumns}, password_hash FROM users WHERE email = $1`, [email],
    );
    const verified = await verifyPassword(password, account?.password_hash ?? missingAccountHash);
    if (!verified || account?.status !== 'active') {
      throw new UnauthorizedException('Invalid email or password');
    }
    const token = randomBytes(32).toString('hex');
    await this.db.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    // Lock the user during issuance so a concurrent password change can revoke every old session.
    const { rowCount } = await this.db.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       SELECT $1, id, now() + ($3 * interval '1 second') FROM users
       WHERE id = $2 AND status = 'active' AND password_hash = $4 FOR UPDATE`,
      [tokenHash(token), account.id, sessionSeconds, account.password_hash],
    );
    if (!rowCount) throw new UnauthorizedException('Invalid email or password');
    return { token, expiresIn: sessionSeconds };
  }

  async account(authorization: string | undefined) {
    const { rows: [account] } = await this.db.pool.query<Account>(
      `SELECT u.id, u.email, u.name, u.system_role AS "systemRole", u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
      [tokenHash(sessionToken(authorization))],
    );
    if (!account) throw new UnauthorizedException();
    return account;
  }

  async logout(authorization: string | undefined) {
    await this.db.pool.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash(sessionToken(authorization)),
    ]);
  }

  async updateProfile(actor: Account, body: unknown) {
    const name = textInput(objectInput(body).name, 'name', 100);
    return this.db.transaction(async (client) => {
      const { rows: [account] } = await client.query<Account>(
        `UPDATE users SET name = $2, updated_at = now() WHERE id = $1 AND status = 'active'
         RETURNING ${accountColumns}`,
        [actor.id, name],
      );
      if (!account) throw new UnauthorizedException();
      await this.auditOwnAccount(client, actor.id, 'user.profile_updated');
      return account;
    });
  }

  async changePassword(actor: Account, body: unknown) {
    const input = objectInput(body);
    const currentPassword = passwordInput(input.currentPassword, 1);
    const newPassword = passwordInput(input.newPassword);
    if (currentPassword === newPassword) throw new BadRequestException('New password must differ from current password');
    const { rows: [credentials] } = await this.db.pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1 AND status = 'active'", [actor.id],
    );
    if (!credentials) throw new UnauthorizedException();
    if (!(await verifyPassword(currentPassword, credentials.password_hash))) {
      throw new ForbiddenException('Current password is incorrect');
    }
    const hash = await hashPassword(newPassword);
    await this.db.transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE users SET password_hash = $2, updated_at = now()
         WHERE id = $1 AND status = 'active' AND password_hash = $3`,
        [actor.id, hash, credentials.password_hash],
      );
      if (!rowCount) throw new ConflictException('Account changed while updating password');
      await client.query('DELETE FROM sessions WHERE user_id = $1', [actor.id]);
      await this.auditOwnAccount(client, actor.id, 'user.password_changed');
    });
  }

  private async auditOwnAccount(client: PoolClient, accountId: string, action: 'user.profile_updated' | 'user.password_changed') {
    await client.query("SELECT set_config('ado.audit_account', $1, true)", [accountId]);
    await client.query('INSERT INTO audit_logs (actor_id, action, resource_id) VALUES ($1, $2, $1)', [accountId, action]);
  }

  async listUsers(actor: Account) {
    this.requireAdmin(actor);
    const { rows } = await this.db.pool.query<Account>(`SELECT ${accountColumns} FROM users ORDER BY email`);
    return rows;
  }

  async createUser(actor: Account, body: unknown) {
    this.requireAdmin(actor);
    const input = objectInput(body);
    const email = emailInput(input.email);
    const name = textInput(input.name, 'name', 100);
    const hash = await hashPassword(passwordInput(input.password));
    try {
      return await this.db.transaction(async (client) => {
        const { rows: [account] } = await client.query<Account>(
          `INSERT INTO users (email, name, password_hash, system_role) VALUES ($1, $2, $3, 'user')
           RETURNING ${accountColumns}`, [email, name, hash],
        );
        await client.query("SELECT set_config('ado.audit_admin', $1, true)", [actor.id]);
        await client.query(
          `INSERT INTO audit_logs (actor_id, action, resource_id) VALUES ($1, 'user.created', $2)`,
          [actor.id, account.id],
        );
        return account;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Email already in use');
      throw error;
    }
  }

  requireAdmin(account: Account) {
    if (account.systemRole !== 'admin') throw new ForbiddenException('Administrator required');
  }
}

type SessionRequest = { headers: { authorization?: string }; account: Account };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    request.account = await this.auth.account(request.headers.authorization);
    return true;
  }
}

export const CurrentAccount = createParamDecorator((_, context: ExecutionContext) =>
  context.switchToHttp().getRequest<SessionRequest>().account,
);

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('auth/session')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.auth.login(body);
  }

  @Get('auth/session')
  @UseGuards(SessionGuard)
  account(@CurrentAccount() account: Account) {
    return account;
  }

  @Delete('auth/session')
  @HttpCode(204)
  logout(@Headers('authorization') authorization?: string) {
    return this.auth.logout(authorization);
  }

  @Patch('auth/profile')
  @UseGuards(SessionGuard)
  updateProfile(@CurrentAccount() account: Account, @Body() body: unknown) {
    return this.auth.updateProfile(account, body);
  }

  @Patch('auth/password')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  changePassword(@CurrentAccount() account: Account, @Body() body: unknown) {
    return this.auth.changePassword(account, body);
  }

  @Get('users')
  @UseGuards(SessionGuard)
  users(@CurrentAccount() account: Account) {
    return this.auth.listUsers(account);
  }

  @Post('users')
  @UseGuards(SessionGuard)
  createUser(@CurrentAccount() account: Account, @Body() body: unknown) {
    return this.auth.createUser(account, body);
  }
}
