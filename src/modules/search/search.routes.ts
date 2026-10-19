import { PermissionModule } from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import { prisma } from '../../config/prisma';
import { requireAuth } from '../../middleware/requireAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { formatPartialCnic } from '../../utils/cnic';
import { userHasPermission } from '../../utils/permissions';
import { Unauthorized } from '../../utils/apiResponse';
import { publicUrl } from '../../services/storage';
import { receiptSuffixFromQuery } from '../../utils/receiptNo';
import { pktDayString } from '../../utils/pktDate';
import { formatPKR } from '../../utils/money';

export const searchRouter = Router();

const EMPTY = { students: [], teachers: [], parents: [], classes: [], challans: [], receipts: [] };

searchRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.user;
    if (!actor) throw Unauthorized();

    const q = (req.query.q as string || '').trim();
    if (!q || q.length < 1) {
      return res.json(EMPTY);
    }

    const qCnic = formatPartialCnic(q);

    // Global search spans the whole school, so each section is gated on the
    // same module that guards its page. Without this any signed-in user —
    // including a parent — could enumerate every student, guardian and challan.
    // Unpermitted sections are skipped entirely, so the rows are never read.
    const [mayStudents, mayTeachers, mayParents, mayClasses, mayFees] = await Promise.all([
      userHasPermission(actor.userId, actor.role, PermissionModule.STUDENTS, 'view'),
      userHasPermission(actor.userId, actor.role, PermissionModule.STAFF, 'view'),
      userHasPermission(actor.userId, actor.role, PermissionModule.PARENTS, 'view'),
      userHasPermission(actor.userId, actor.role, PermissionModule.CLASSES, 'view'),
      userHasPermission(actor.userId, actor.role, PermissionModule.FEES, 'view'),
    ]);

    const tokens = q.split(/\s+/).filter(Boolean);
    // Receipt numbers are the tail of a payment id, so they're only looked up
    // when the query is shaped like one.
    const receiptSuffix = mayFees ? receiptSuffixFromQuery(q) : null;

    const [students, teachers, parents, classes, challans, feeReceipts, transportReceipts] = await Promise.all([
      !mayStudents ? [] : prisma.student.findMany({
        where: {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            {
              AND: tokens.map((token) => ({
                OR: [
                  { firstName: { contains: token, mode: 'insensitive' } },
                  { lastName: { contains: token, mode: 'insensitive' } },
                ],
              })),
            },
            { rollNo: { contains: q, mode: 'insensitive' } },
            { admissionNo: { contains: q, mode: 'insensitive' } },
            { bFormNo: { contains: q, mode: 'insensitive' } },
            { bFormNo: { contains: qCnic, mode: 'insensitive' } },
            { parent: { user: { fullName: { contains: q, mode: 'insensitive' } } } },
            {
              parent: {
                user: {
                  AND: tokens.map((token) => ({
                    fullName: { contains: token, mode: 'insensitive' },
                  })),
                },
              },
            },
            { parent: { user: { cnic: { contains: q, mode: 'insensitive' } } } },
            { parent: { user: { cnic: { contains: qCnic, mode: 'insensitive' } } } },
          ],
        },
        take: 10,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          rollNo: true,
          admissionNo: true,
          photoUrl: true,
          section: { select: { name: true, class: { select: { name: true } } } },
        },
      }),
      !mayTeachers ? [] : prisma.teacherProfile.findMany({
        where: {
          OR: [
            { user: { fullName: { contains: q, mode: 'insensitive' } } },
            { employeeId: { contains: q, mode: 'insensitive' } },
            { user: { cnic: { contains: q, mode: 'insensitive' } } },
            { user: { cnic: { contains: qCnic, mode: 'insensitive' } } },
            { user: { designation: { contains: q, mode: 'insensitive' } } },
          ],
        },
        take: 10,
        select: {
          id: true,
          employeeId: true,
          user: { select: { fullName: true, avatarUrl: true, designation: true } },
        },
      }),
      !mayParents ? [] : prisma.parentProfile.findMany({
        where: {
          OR: [
            { user: { fullName: { contains: q, mode: 'insensitive' } } },
            { user: { phone: { contains: q, mode: 'insensitive' } } },
            { user: { cnic: { contains: q, mode: 'insensitive' } } },
            { user: { cnic: { contains: qCnic, mode: 'insensitive' } } },
            { motherCnic: { contains: q, mode: 'insensitive' } },
            { motherCnic: { contains: qCnic, mode: 'insensitive' } },
          ],
        },
        take: 10,
        select: {
          id: true,
          user: { select: { fullName: true, phone: true, avatarUrl: true } },
          _count: { select: { students: true } },
        },
      }),
      !mayClasses ? [] : prisma.class.findMany({
        where: { name: { contains: q, mode: 'insensitive' } },
        take: 10,
        select: { id: true, name: true, sections: { select: { id: true, name: true } } },
      }),
      !mayFees ? [] : prisma.feeChallan.findMany({
        where: {
          OR: [
            { challanNo: { contains: q, mode: 'insensitive' } },
            { student: { firstName: { contains: q, mode: 'insensitive' } } },
            { student: { lastName: { contains: q, mode: 'insensitive' } } },
            {
              student: {
                AND: tokens.map((token) => ({
                  OR: [
                    { firstName: { contains: token, mode: 'insensitive' } },
                    { lastName: { contains: token, mode: 'insensitive' } },
                  ],
                })),
              },
            },
            { student: { admissionNo: { contains: q, mode: 'insensitive' } } },
            { student: { rollNo: { contains: q, mode: 'insensitive' } } },
            { student: { parent: { user: { fullName: { contains: q, mode: 'insensitive' } } } } },
          ],
        },
        take: 10,
        select: {
          id: true,
          challanNo: true,
          year: true,
          month: true,
          amount: true,
          status: true,
          student: { select: { firstName: true, lastName: true } },
        },
      }),
      !receiptSuffix ? [] : prisma.feePayment.findMany({
        where: { id: { endsWith: receiptSuffix } },
        take: 5,
        select: {
          id: true,
          amount: true,
          paymentDate: true,
          isReversed: true,
          student: { select: { firstName: true, lastName: true, admissionNo: true } },
        },
      }),
      !receiptSuffix ? [] : prisma.transportPayment.findMany({
        where: { id: { endsWith: receiptSuffix } },
        take: 5,
        select: {
          id: true,
          amount: true,
          paymentDate: true,
          isReversed: true,
          challan: {
            select: {
              id: true,
              student: { select: { firstName: true, lastName: true } },
              teacher: { select: { user: { select: { fullName: true } } } },
            },
          },
        },
      }),
    ]);

    const receiptNo = (id: string) => id.slice(-6).toUpperCase();
    const fullName = (s: { firstName: string; lastName: string | null }) => `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`;

    res.json({
      students: students.map((s) => ({
        id: s.id,
        title: `${s.firstName}${s.lastName ? ` ${s.lastName}` : ''}`,
        subtitle: `Roll: ${s.rollNo || 'N/A'} · Adm: ${s.admissionNo} · ${s.section.class.name}-${s.section.name}`,
        url: `/students?search=${encodeURIComponent(s.admissionNo)}`,
        photoUrl: publicUrl(s.photoUrl),
      })),
      teachers: teachers.map((t) => ({
        id: t.id,
        title: t.user.fullName,
        subtitle: `${t.user.designation || 'Staff'} · Emp ID: ${t.employeeId}`,
        url: `/staff?search=${encodeURIComponent(t.employeeId)}`,
        avatarUrl: publicUrl(t.user.avatarUrl),
      })),
      parents: parents.map((p) => ({
        id: p.id,
        title: p.user.fullName,
        subtitle: `Phone: ${p.user.phone || 'N/A'} · ${p._count.students} Children`,
        url: `/parents?search=${encodeURIComponent(p.user.fullName)}`,
        avatarUrl: publicUrl(p.user.avatarUrl),
      })),
      classes: classes.map((c) => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.sections.length} Sections (${c.sections.map((s) => s.name).join(', ')})`,
        url: `/classes`,
      })),
      challans: challans.map((ch) => ({
        id: ch.id,
        title: `Challan #${ch.challanNo}`,
        subtitle: `${ch.student.firstName}${ch.student.lastName ? ` ${ch.student.lastName}` : ''} · Rs. ${ch.amount} (${ch.status})`,
        // Opens the challan itself; the Challans tab doesn't read a search param.
        url: `/fees?tab=challans&challan=${encodeURIComponent(ch.id)}`,
      })),
      receipts: [
        ...feeReceipts.map((p) => ({
          id: p.id,
          title: `Receipt #${receiptNo(p.id)}`,
          subtitle: `Fee · ${fullName(p.student)} (${p.student.admissionNo}) · ${formatPKR(p.amount)} · ${pktDayString(p.paymentDate)}${p.isReversed ? ' · Reversed' : ''}`,
          url: `/fees?tab=payments&receipt=${receiptNo(p.id)}`,
        })),
        // A transport receipt opens its challan, which lists every receipt against it.
        ...transportReceipts.map((p) => ({
          id: p.id,
          title: `Receipt #${receiptNo(p.id)}`,
          subtitle: `Transport · ${p.challan.student ? fullName(p.challan.student) : (p.challan.teacher?.user.fullName ?? '—')} · ${formatPKR(p.amount)} · ${pktDayString(p.paymentDate)}${p.isReversed ? ' · Reversed' : ''}`,
          url: `/transport?tab=payments&challan=${encodeURIComponent(p.challan.id)}`,
        })),
      ],
    });
  }),
);
