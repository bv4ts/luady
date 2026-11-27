import { AnswerBodySchema } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { EmptyBodySchema, QidParamsSchema, QuestionsQuerySchema } from '../schemas.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

export const questionRoutes: RouteModule = (app, ctx) => {
  const { questions } = ctx.deps;
  app.get('/api/questions', async (request) => {
    parseQuery(QuestionsQuerySchema, request.query);
    return questions.pending();
  });
  app.post('/api/questions/:qid/answer', async (request) => {
    const { qid } = parseParams(QidParamsSchema, request.params);
    const body = parseBody(AnswerBodySchema, request.body);
    if ('answers' in body) return questions.answer(qid, body.answers, 'web');
    return questions.answerPermission(qid, body.behavior, body.message, 'web', { always: 'always' in body && body.always === true });
  });
  app.post('/api/questions/:qid/release', async (request) => {
    const { qid } = parseParams(QidParamsSchema, request.params);
    parseBody(EmptyBodySchema, request.body);
    return questions.release(qid, 'web');
  });
};
