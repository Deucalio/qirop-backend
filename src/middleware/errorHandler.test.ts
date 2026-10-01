import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { errorHandler } from './errorHandler';

function responseCapture() {
  let statusCode = 0;
  let body: unknown;
  const response = {
    headersSent: false,
    status: (status: number) => {
      statusCode = status;
      return response;
    },
    json: (payload: unknown) => {
      body = payload;
      return response;
    },
  };
  return { response, result: () => ({ statusCode, body }) };
}

function uniqueError(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

test('reports a challan-number conflict without hiding its cause', () => {
  const capture = responseCapture();
  errorHandler(uniqueError(['challanNo']), {} as never, capture.response as never, (() => undefined) as never);

  assert.deepEqual(capture.result(), {
    statusCode: 409,
    body: {
      error: {
        message: 'A duplicate challan number was detected. Please retry the request.',
        code: 'CHALLAN_NUMBER_CONFLICT',
        details: { fields: ['challanNo'] },
      },
    },
  });
});

test('reports the student-month challan constraint separately', () => {
  const capture = responseCapture();
  errorHandler(
    uniqueError(['studentId', 'year', 'month']),
    {} as never,
    capture.response as never,
    (() => undefined) as never,
  );

  assert.deepEqual(capture.result().body, {
    error: {
      message: 'A fee challan already exists for this student and month.',
      code: 'CHALLAN_ALREADY_EXISTS',
      details: { fields: ['studentId', 'year', 'month'] },
    },
  });
});
