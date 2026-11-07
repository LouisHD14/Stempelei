import type { FastifyInstance } from 'fastify';
import { cardUrl, guestCardView, qrSvg, TOKEN_PATTERN } from '../cards.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { onCardChange } from '../live.js';

const tokenParam = {
  params: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string', pattern: TOKEN_PATTERN } },
  },
};
const HEARTBEAT_MS = 25_000;

/** Seiten und API für Gäste. Wer das Token kennt, sieht die Karte, sonst nichts. */
export async function publicRoutes(
  app: FastifyInstance,
  { config, db }: { config: Config; db: Db },
): Promise<void> {
  // Ratenbegrenzung pro IP, damit niemand Tokens durchprobiert
  const limit = app.rateLimit({ max: 60, timeWindow: 60_000, keyGenerator: (req) => `guest|${req.ip}` });
  const notFound = { error: 'not_found', message: 'Diese Karte gibt es nicht.' };

  app.get<{ Params: { token: string } }>(
    '/api/public/cards/:token',
    { preHandler: limit, schema: tokenParam },
    async (req, reply) => {
      const view = await guestCardView(db, req.params.token);
      if (!view) return reply.code(404).send(notFound);
      const { id: _id, ...card } = view;
      return reply
        .header('Cache-Control', 'no-store')
        .send({ card, url: cardUrl(config.publicUrl, req.params.token) });
    },
  );

  app.get<{ Params: { token: string } }>(
    '/api/public/cards/:token/qr.svg',
    { preHandler: limit, schema: tokenParam },
    async (req, reply) => {
      // Kein Datenbankzugriff nötig: Der Code enthält nur den Link. Unbekannte Tokens führen auf eine 404-Seite.
      return reply
        .type('image/svg+xml')
        .header('Cache-Control', 'private, max-age=86400')
        .send(qrSvg(cardUrl(config.publicUrl, req.params.token)));
    },
  );

  // Live-Updates für die Gast-Ansicht. Der Browser verbindet sich bei Abbruch selbst neu.
  app.get<{ Params: { token: string } }>(
    '/api/public/cards/:token/live',
    { preHandler: limit, schema: tokenParam },
    async (req, reply) => {
      const first = await guestCardView(db, req.params.token);
      if (!first) return reply.code(404).send(notFound);
      const cardId = first.id;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // Proxys wie nginx sollen nicht puffern
        'X-Accel-Buffering': 'no',
      });
      const send = async () => {
        const view = await guestCardView(db, req.params.token).catch(() => null);
        if (!view || res.writableEnded) return;
        const { id: _id, ...card } = view;
        res.write(`event: card\ndata: ${JSON.stringify(card)}\n\n`);
      };
      const off = onCardChange(cardId, () => void send());
      const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      req.raw.on('close', () => {
        off();
        clearInterval(beat);
      });
      res.write('retry: 3000\n\n');
    },
  );

  app.get<{ Params: { token: string } }>('/c/:token', { schema: tokenParam }, (_req, reply) =>
    reply.header('Cache-Control', 'no-cache').header('Referrer-Policy', 'no-referrer').sendFile('card.html'),
  );
}
