/**
 * Token-authed downloads (Phase 2.2) — mounted at /api/v1/exports.
 *
 * Deliberately its own sub-app rather than another route under /api/v1/manage. Everything
 * under `manage` is admin-bearer-authed by one middleware, and that uniformity is worth
 * keeping: a route inside it that accepted a query-string credential instead would be an
 * exception a reader has to notice. Query-parameter auth is a weaker posture than a header,
 * so it lives somewhere it can be seen and reviewed on its own.
 *
 * The body of the response is produced by exactly the same code as the admin-authed CSV
 * route — same query, same derivations, same columns. Two doors, one report; a download that
 * disagreed with the API would be its own small version of the argument this phase ends.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { authenticateExportToken } from '../exports';
import { loadEventQuestions } from '../questions';
import { csvFilename, listEventRegistrations, registrationsToCsv } from '../reporting';
import type { Env } from '../types';

type ExportBindings = { Bindings: Env };

async function handleRegistrationsCsv(c: Context<ExportBindings>): Promise<Response> {
  const eventId = c.req.param('id') as string;
  const token = c.req.query('token') ?? '';
  if (token === '') {
    return c.json({ status: 'unauthorized', message: 'A download token is required' }, 401);
  }

  // The token names the portal, the scope AND the event, and all three are checked before
  // a row is read — so a token minted for one event cannot fetch another's attendee list,
  // and one minted for a different export cannot be replayed here.
  const claims = await authenticateExportToken(c.env, token, {
    scope: 'registrations.csv',
    eventId,
  });
  if (!claims) {
    return c.json(
      { status: 'unauthorized', message: 'Download token is invalid or has expired' },
      401,
    );
  }

  const event = await c.env.DB.prepare(
    'SELECT id, title FROM events WHERE portal_id = ?1 AND id = ?2',
  )
    .bind(claims.portalId, eventId)
    .first<{ id: string; title: string }>();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  // The question set supplies the answer columns, so a question nobody answered still gets
  // an (empty) column — see `answerColumns`.
  const [rows, questions] = await Promise.all([
    listEventRegistrations(c.env, claims.portalId, eventId),
    loadEventQuestions(c.env, claims.portalId, eventId),
  ]);
  const generatedAt = new Date().toISOString();

  return new Response(registrationsToCsv(rows, questions), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(event.title, event.id, generatedAt)}"`,
      // This file is attendee PII and the URL is shareable for as long as the token lives.
      // A copy in a shared browser cache would outlive both.
      'Cache-Control': 'no-store',
      // The token is in the URL, so keep it out of any onward Referer.
      'Referrer-Policy': 'no-referrer',
      // A CSV rendered rather than saved is a scripting surface; this file is only ever
      // meant to be downloaded.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const exports = new Hono<ExportBindings>();

exports.get('/events/:id/registrations.csv', handleRegistrationsCsv);

export const exportRoutes = exports;
