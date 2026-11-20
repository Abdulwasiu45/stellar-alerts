import { FastifyRequest, FastifyReply } from 'fastify';
import { purgeDlqJobs, retryDlqJobs } from '../../lib/queue';
import { dlqReplayService, DlqFilterParams } from './dlq-replay.service';

export class DlqController {
  async inspect(
    req: FastifyRequest<{ Querystring: DlqFilterParams }>,
    reply: FastifyReply,
  ) {
    try {
      const result = await dlqReplayService.inspectDlq(req.query);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }

  async replay(
    req: FastifyRequest<{
      Body: {
        ids?: string[];
        filter?: DlqFilterParams;
        force?: boolean;
      };
    }>,
    reply: FastifyReply,
  ) {
    try {
      const actorUserId = (req as any).user?.id;
      const result = await dlqReplayService.replayJobs({
        ...req.body,
        actorUserId,
      });
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }

  async purge(
    req: FastifyRequest<{
      Body: {
        olderThanDays?: number;
        olderThanDate?: string;
        status?: string;
        channel?: string;
      };
    }>,
    reply: FastifyReply,
  ) {
    try {
      const actorUserId = (req as any).user?.id;
      const result = await dlqReplayService.purgeJobs({
        ...req.body,
        actorUserId,
      });
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }

  async retry(
    req: FastifyRequest<{
      Body: {
        ids?: string[];
        limit?: number;
      };
    }>,
    reply: FastifyReply,
  ) {
    try {
      const result = await retryDlqJobs(req.body ?? {});
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }

  async purgeQueue(
    req: FastifyRequest<{
      Body?: {
        after?: string;
        before?: string;
        olderThanDays?: number;
        limit?: number;
      };
      Querystring: {
        after?: string;
        before?: string;
        olderThanDays?: string;
        limit?: string;
      };
    }>,
    reply: FastifyReply,
  ) {
    try {
      const query = req.query ?? {};
      const olderThanDays = query.olderThanDays !== undefined ? Number(query.olderThanDays) : undefined;
      const limit = query.limit !== undefined ? Number(query.limit) : undefined;
      const result = await purgeDlqJobs({
        ...req.body,
        after: req.body?.after ?? query.after,
        before: req.body?.before ?? query.before,
        olderThanDays: req.body?.olderThanDays ?? olderThanDays,
        limit: req.body?.limit ?? limit,
      });
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  }
}

export const dlqController = new DlqController();
