import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Member, NewMember, Role, Team } from '@open-version/contracts';
import { hashPassword, newPassword, requireAccount, teamAccess } from '../auth.js';
import type { Pool } from '../db.js';
import { HttpError } from '../errors.js';
import { name, slug, slugify, teamParam, uuid } from './shared.js';

const role = z.enum(['admin', 'developer', 'viewer']);

export function registerTeamRoutes(app: FastifyInstance, pool: Pool): void {
  const serverAdmin = (request: Parameters<typeof requireAccount>[0]) => {
    const account = requireAccount(request);
    if (!account.isServerAdmin) throw new HttpError(403, 'Only a server admin can manage teams.');
    return account;
  };

  app.get('/api/teams', async (request): Promise<Team[]> => {
    serverAdmin(request);
    const { rows } = await pool.query<Team>(
      'SELECT id, slug, name, created_at AS "createdAt" FROM teams ORDER BY name',
    );
    return rows;
  });

  app.post('/api/teams', async (request, reply): Promise<Team> => {
    serverAdmin(request);
    const body = z.object({ name, slug: slug.optional() }).parse(request.body);
    const { rows } = await pool.query<Team>(
      `INSERT INTO teams (slug, name) VALUES ($1, $2)
       RETURNING id, slug, name, created_at AS "createdAt"`,
      [body.slug ?? slugify(body.name), body.name],
    );
    void reply.code(201);
    return rows[0];
  });

  app.patch('/api/t/:team', async (request): Promise<{ ok: true }> => {
    const { team } = teamParam.parse(request.params);
    const access = await teamAccess(pool, request, team, ['admin']);
    const body = z.object({ name }).parse(request.body);
    await pool.query('UPDATE teams SET name = $2 WHERE id = $1', [access.teamId, body.name]);
    return { ok: true };
  });

  app.delete('/api/t/:team', async (request): Promise<{ ok: true }> => {
    serverAdmin(request);
    const { team } = teamParam.parse(request.params);
    await pool.query('DELETE FROM teams WHERE slug = $1', [team]);
    return { ok: true };
  });

  // Members --------------------------------------------------------------------------------

  app.get('/api/t/:team/members', async (request): Promise<Member[]> => {
    const { team } = teamParam.parse(request.params);
    const access = await teamAccess(pool, request, team, ['admin']);
    const { rows } = await pool.query<Member>(
      `SELECT a.id AS "accountId", a.email, a.name, m.role
         FROM members m JOIN accounts a ON a.id = m.account_id
        WHERE m.team_id = $1 ORDER BY a.name, a.email`,
      [access.teamId],
    );
    return rows;
  });

  /** Adds someone by email. A new account gets a password, shown this once. */
  app.post('/api/t/:team/members', async (request, reply): Promise<NewMember> => {
    const { team } = teamParam.parse(request.params);
    const access = await teamAccess(pool, request, team, ['admin']);
    const body = z
      .object({ email: z.email().max(200), name: z.string().trim().max(120).default(''), role })
      .parse(request.body);
    const email = body.email.toLowerCase();
    const password = newPassword();
    const created = await pool.query<{ id: string; name: string; created: boolean }>(
      `INSERT INTO accounts (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, name, (xmax = 0) AS created`,
      [email, body.name, await hashPassword(password)],
    );
    const account = created.rows[0];
    const inserted = await pool.query(
      `INSERT INTO members (team_id, account_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [access.teamId, account.id, body.role],
    );
    if (!inserted.rowCount) throw new HttpError(409, `${email} is already a member.`);
    void reply.code(201);
    return {
      accountId: account.id,
      email,
      name: account.name,
      role: body.role,
      password: account.created ? password : null,
    };
  });

  app.patch('/api/t/:team/members/:accountId', async (request): Promise<{ ok: true }> => {
    const params = z.object({ team: slug, accountId: uuid }).parse(request.params);
    const access = await teamAccess(pool, request, params.team, ['admin']);
    // Nobody changes their own role: an admin can't lock the team out by accident, and
    // nobody can raise their own rights.
    if (params.accountId === access.account.id) {
      throw new HttpError(403, 'You can’t change your own role. Ask another admin.');
    }
    const body = z.object({ role }).parse(request.body);
    const result = await pool.query(
      'UPDATE members SET role = $3 WHERE team_id = $1 AND account_id = $2',
      [access.teamId, params.accountId, body.role satisfies Role],
    );
    if (!result.rowCount) throw new HttpError(404, 'That member wasn’t found.');
    return { ok: true };
  });

  app.delete('/api/t/:team/members/:accountId', async (request): Promise<{ ok: true }> => {
    const params = z.object({ team: slug, accountId: uuid }).parse(request.params);
    const access = await teamAccess(pool, request, params.team, ['admin']);
    if (params.accountId === access.account.id) {
      throw new HttpError(403, 'You can’t remove yourself. Ask another admin.');
    }
    await pool.query('DELETE FROM members WHERE team_id = $1 AND account_id = $2', [
      access.teamId,
      params.accountId,
    ]);
    return { ok: true };
  });
}
