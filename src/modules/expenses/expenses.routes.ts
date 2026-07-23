import { Router } from 'express';
import { PermissionModule } from '@prisma/client';
import * as c from './expenses.controller';
import { createExpenseSchema, updateExpenseSchema } from './expenses.schema';
import { requireAuth } from '../../middleware/requireAuth';
import { requirePermission } from '../../middleware/requirePermission';
import { validateBody } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { imageUpload } from '../../config/upload';

const EXPENSES = PermissionModule.EXPENSES;
const view = requirePermission(EXPENSES, 'view');
const edit = requirePermission(EXPENSES, 'edit');
const manage = requirePermission(EXPENSES, 'manage');

export const expensesRouter = Router();
expensesRouter.use(requireAuth);

expensesRouter.get('/summary', view, asyncHandler(c.summary));
expensesRouter.get('/', view, asyncHandler(c.list));
expensesRouter.post('/', edit, validateBody(createExpenseSchema), asyncHandler(c.create));
expensesRouter.get('/:id', view, asyncHandler(c.detail));
expensesRouter.put('/:id', edit, validateBody(updateExpenseSchema), asyncHandler(c.update));
expensesRouter.delete('/:id', manage, asyncHandler(c.remove));
expensesRouter.post('/:id/receipt', edit, imageUpload.single('receipt'), asyncHandler(c.uploadReceipt));
expensesRouter.get('/:id/receipt', view, asyncHandler(c.downloadReceipt));

// Finance overview (income vs expenses vs salaries). Gated by EXPENSES view.
export const financeRouter = Router();
financeRouter.use(requireAuth);
financeRouter.get('/summary', view, asyncHandler(c.finance));
