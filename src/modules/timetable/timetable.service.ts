import { randomUUID } from 'node:crypto';
import { AttendanceStatus, DayOfWeek, Role, UserStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError, Forbidden, NotFound } from '../../utils/apiResponse';
import { pktDay, pktDayString, parsePktDay, isFuturePktDay } from '../../utils/pktDate';
import { subjectColorMap, BUILT_IN_COLORS } from '../academics/subjectColors';

export interface Actor {
  userId: string;
  role: Role;
}

export const SCHOOL_DAYS: DayOfWeek[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** JS getUTCDay() (0=Sun) → school DayOfWeek, or null on Sunday. */
export function dayOfWeekFor(date: Date): DayOfWeek | null {
  const idx = date.getUTCDay(); // canonical PKT days are UTC-midnight
  return idx === 0 ? null : SCHOOL_DAYS[idx - 1];
}

// ---------------------------------------------------------------------------
// Period template (school-wide, stored in School.settings as flat keys)
// ---------------------------------------------------------------------------

export interface PeriodDef {
  index: number;
  label: string;
  start: string; // "08:00"
  end: string; // "08:45"
}

/** What the admin configures for one weekday (stored in School.settings.timetable). */
export interface DayConfig {
  open: boolean;
  start: string; // "08:00"
  periods: number[]; // duration in minutes, one entry per period (lengths may differ)
  breakAfter: number; // the break follows this period; 0 = no break
  breakMinutes: number;
  breakLabel: string;
}

export type TimetableConfig = Record<DayOfWeek, DayConfig>;

/** One day's computed clock times. */
export interface DaySchedule {
  day: DayOfWeek;
  open: boolean;
  start: string;
  end: string;
  periods: PeriodDef[];
  breakAfter: number; // 0 = none
  breakLabel: string;
  breakTime: { start: string; end: string } | null;
}

export interface TimetableLayout {
  config: TimetableConfig;
  schedules: DaySchedule[]; // open days only, in week order
  openDays: DayOfWeek[];
  maxPeriods: number; // widest day — how many period columns the grid needs
}

const MAX_PERIODS_PER_DAY = 14;
const MIN_PERIOD_MINUTES = 5;
const MAX_PERIOD_MINUTES = 240;

/**
 * Defaults reflect the school's actual timings:
 *   Mon–Thu, Sat  8:00 AM – 1:30 PM, break 11:30 – 12:00
 *   Friday        8:00 AM – 12:30 PM, break 11:00 – 11:30 (Jummah)
 * Period lengths differ around the break so the break lands on the exact clock
 * time; admins can change any of this in School Setup → Periods & Timings.
 */
const STANDARD_DAY: DayConfig = {
  open: true,
  start: '08:00',
  periods: [42, 42, 42, 42, 42, 45, 45],
  breakAfter: 5,
  breakMinutes: 30,
  breakLabel: 'Break',
};

const FRIDAY: DayConfig = {
  open: true,
  start: '08:00',
  periods: [45, 45, 45, 45, 30, 30],
  breakAfter: 4,
  breakMinutes: 30,
  breakLabel: 'Jummah Break',
};

export function defaultTimetableConfig(): TimetableConfig {
  const clone = (d: DayConfig): DayConfig => ({ ...d, periods: [...d.periods] });
  return {
    MON: clone(STANDARD_DAY),
    TUE: clone(STANDARD_DAY),
    WED: clone(STANDARD_DAY),
    THU: clone(STANDARD_DAY),
    FRI: clone(FRIDAY),
    SAT: clone(STANDARD_DAY),
  };
}

const clampInt = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

const minutesToHHMM = (mins: number) =>
  `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

const hhmmToMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Coerce arbitrary stored/posted JSON into a valid day config. */
function normalizeDay(raw: unknown, fallback: DayConfig): DayConfig {
  const d = (raw ?? {}) as Record<string, unknown>;

  const periodsRaw = Array.isArray(d.periods) ? d.periods : fallback.periods;
  const periods = periodsRaw
    .slice(0, MAX_PERIODS_PER_DAY)
    .map((p) => clampInt(p, 45, MIN_PERIOD_MINUTES, MAX_PERIOD_MINUTES));
  if (periods.length === 0) periods.push(45);

  const start =
    typeof d.start === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.start) ? d.start : fallback.start;

  return {
    open: typeof d.open === 'boolean' ? d.open : fallback.open,
    start,
    periods,
    // A break may sit after any period except the last one. An explicit 0 means
    // "no break" and is preserved; only a missing value falls back to the default.
    breakAfter: clampInt(d.breakAfter, fallback.breakAfter, 0, Math.max(0, periods.length - 1)),
    breakMinutes: clampInt(d.breakMinutes, fallback.breakMinutes, MIN_PERIOD_MINUTES, MAX_PERIOD_MINUTES),
    breakLabel:
      typeof d.breakLabel === 'string' && d.breakLabel.trim() ? d.breakLabel.trim().slice(0, 40) : fallback.breakLabel,
  };
}

export function normalizeConfig(raw: unknown): TimetableConfig {
  const defaults = defaultTimetableConfig();
  const source = (raw ?? {}) as Record<string, unknown>;
  return SCHOOL_DAYS.reduce((acc, day) => {
    acc[day] = normalizeDay(source[day], defaults[day]);
    return acc;
  }, {} as TimetableConfig);
}

/** Turn one day's durations into wall-clock period times (break-shifted). */
export function buildDaySchedule(day: DayOfWeek, cfg: DayConfig): DaySchedule {
  const periods: PeriodDef[] = [];
  let t = hhmmToMinutes(cfg.start);
  let breakTime: { start: string; end: string } | null = null;

  cfg.periods.forEach((minutes, i) => {
    const index = i + 1;
    if (cfg.breakAfter > 0 && index === cfg.breakAfter + 1) {
      breakTime = { start: minutesToHHMM(t), end: minutesToHHMM(t + cfg.breakMinutes) };
      t += cfg.breakMinutes;
    }
    periods.push({ index, label: `P${index}`, start: minutesToHHMM(t), end: minutesToHHMM(t + minutes) });
    t += minutes;
  });

  return {
    day,
    open: cfg.open,
    start: cfg.start,
    end: minutesToHHMM(t),
    periods,
    breakAfter: breakTime ? cfg.breakAfter : 0,
    breakLabel: cfg.breakLabel,
    breakTime,
  };
}

export function buildLayout(config: TimetableConfig): TimetableLayout {
  const openDays = SCHOOL_DAYS.filter((d) => config[d].open);
  const schedules = openDays.map((d) => buildDaySchedule(d, config[d]));
  return {
    config,
    schedules,
    openDays,
    maxPeriods: schedules.reduce((n, s) => Math.max(n, s.periods.length), 0),
  };
}

export async function getTimetableLayout(): Promise<TimetableLayout> {
  const school = await prisma.school.findFirst({ select: { settings: true } });
  const settings = (school?.settings ?? {}) as Record<string, unknown>;
  return buildLayout(normalizeConfig(settings.timetable));
}

/** The schedule for one day, or undefined when the school is closed that day. */
export function scheduleFor(layout: TimetableLayout, day: DayOfWeek): DaySchedule | undefined {
  return layout.schedules.find((s) => s.day === day);
}

/**
 * Apply a new school-wide timing configuration. Slots that no longer fit (a day
 * was closed, or lost periods) are removed; everything else is preserved.
 * With `dryRun` nothing is written — used to preview the impact before saving.
 */
export async function saveTimetableConfig(raw: unknown, dryRun: boolean) {
  const config = normalizeConfig(raw);
  const layout = buildLayout(config);

  // Which (day, periodIndex) pairs would become invalid?
  const orphaned = await prisma.timetableSlot.findMany({
    include: { section: { include: { class: true } }, subject: true },
  });
  const doomed = orphaned.filter((slot) => {
    const schedule = scheduleFor(layout, slot.day);
    return !schedule || slot.periodIndex > schedule.periods.length;
  });

  if (!dryRun && doomed.length > 0) {
    await prisma.timetableSlot.deleteMany({ where: { id: { in: doomed.map((s) => s.id) } } });
  }

  if (!dryRun) {
    const school = await prisma.school.findFirst({ select: { id: true, settings: true } });
    if (!school) throw NotFound('School profile not found');
    const settings = (school.settings ?? {}) as Record<string, unknown>;
    await prisma.school.update({
      where: { id: school.id },
      data: { settings: { ...settings, timetable: config } as object },
    });
  }

  return {
    layout,
    removedSlots: doomed.length,
    // Enough detail for the confirmation dialog to name what's affected.
    affected: [...new Set(doomed.map((s) => `${s.section.class.name} · Section ${s.section.name}`))].sort(),
  };
}

/** Resolved hex colour per subject (admin choice, else automatic). */
const subjectColorIndexes = subjectColorMap;

// ---------------------------------------------------------------------------
// Validity window — how long the weekly pattern keeps repeating
// ---------------------------------------------------------------------------

export type TimetableStatus = 'EMPTY' | 'EXPIRED' | 'INCOMPLETE' | 'ACTIVE';

export interface TimetableValidity {
  from: string | null; // 'YYYY-MM-DD'
  until: string | null; // null = repeats with no end date
  status: TimetableStatus;
  filledSlots: number;
  totalSlots: number;
  /** Whole days left until `until` (0 on the last day); null when there is no end date. */
  daysRemaining: number | null;
}

/** Default repeat window applied the first time a section is scheduled: one week. */
export const DEFAULT_REPEAT_DAYS = 7;

/** Total schedulable cells in a week — every period of every open day. */
export function totalWeeklySlots(layout: TimetableLayout): number {
  return layout.schedules.reduce((n, s) => n + s.periods.length, 0);
}

export function buildValidity(
  section: { timetableFrom: Date | null; timetableUntil: Date | null },
  filledSlots: number,
  totalSlots: number,
): TimetableValidity {
  const today = pktDay();
  const until = section.timetableUntil;
  const expired = until !== null && until.getTime() < today.getTime();

  const status: TimetableStatus =
    filledSlots === 0 ? 'EMPTY' : expired ? 'EXPIRED' : filledSlots < totalSlots ? 'INCOMPLETE' : 'ACTIVE';

  return {
    from: section.timetableFrom ? pktDayString(section.timetableFrom) : null,
    until: until ? pktDayString(until) : null,
    status,
    filledSlots,
    totalSlots,
    daysRemaining: until ? Math.round((until.getTime() - today.getTime()) / 86_400_000) : null,
  };
}

/** Set how long the weekly pattern repeats. `until` null = no end date. */
export async function setTimetableValidity(sectionId: string, fromStr: string, untilStr: string | null) {
  await loadSectionOr404(sectionId);
  const from = parsePktDay(fromStr);
  const until = untilStr ? parsePktDay(untilStr) : null;
  if (until && until.getTime() < from.getTime()) {
    throw new AppError('The repeat-until date cannot be before the start date', 400, 'INVALID_RANGE');
  }
  await prisma.section.update({ where: { id: sectionId }, data: { timetableFrom: from, timetableUntil: until } });
  return getSectionTimetable(sectionId);
}

// ---------------------------------------------------------------------------
// Section timetable grid
// ---------------------------------------------------------------------------

async function loadSectionOr404(sectionId: string) {
  const section = await prisma.section.findUnique({ where: { id: sectionId }, include: { class: true } });
  if (!section) throw NotFound('Section not found');
  return section;
}

/** Resolve the teacher for every (section,subject) pair currently on the grid. */
async function teacherBySubject(sectionId: string) {
  const assignments = await prisma.teachingAssignment.findMany({
    where: { sectionId },
    include: { teacher: { include: { user: true } } },
  });
  return new Map(
    assignments.map((a) => [
      a.subjectId,
      { id: a.teacher.id, fullName: a.teacher.user.fullName, status: a.teacher.status },
    ]),
  );
}

export async function getSectionTimetable(sectionId: string) {
  const section = await loadSectionOr404(sectionId);
  const [layout, slots, teachers, colors] = await Promise.all([
    getTimetableLayout(),
    prisma.timetableSlot.findMany({ where: { sectionId }, include: { subject: true } }),
    teacherBySubject(sectionId),
    subjectColorIndexes(),
  ]);

  // For combined lessons, name the other sections sharing each slot.
  const groupIds = slots.map((s) => s.groupId).filter((g): g is string => !!g);
  const partnersByGroup = new Map<string, { sectionId: string; sectionName: string; className: string }[]>();
  if (groupIds.length > 0) {
    const partners = await prisma.timetableSlot.findMany({
      where: { groupId: { in: groupIds }, sectionId: { not: sectionId } },
      include: { section: { include: { class: true } } },
    });
    for (const p of partners) {
      const list = partnersByGroup.get(p.groupId!) ?? [];
      list.push({ sectionId: p.sectionId, sectionName: p.section.name, className: p.section.class.name });
      partnersByGroup.set(p.groupId!, list);
    }
  }

  return {
    sectionId: section.id,
    sectionName: section.name,
    classId: section.classId,
    className: section.class.name,
    days: layout.openDays,
    schedules: layout.schedules,
    maxPeriods: layout.maxPeriods,
    validity: buildValidity(section, slots.length, totalWeeklySlots(layout)),
    slots: slots.map((s) => ({
      day: s.day,
      periodIndex: s.periodIndex,
      subject: { id: s.subject.id, name: s.subject.name, color: colors.get(s.subject.id) ?? BUILT_IN_COLORS[0] },
      // null when an assignment was removed historically — surfaced as a warning in the UI.
      teacher: teachers.get(s.subjectId) ?? null,
      /** Other sections taught together with this one in the same lesson. */
      combinedWith: s.groupId ? (partnersByGroup.get(s.groupId) ?? []) : [],
    })),
  };
}

/**
 * Everything the "what can I schedule here?" picker needs: every subject the
 * class offers, its teacher in this section, whether that teacher is already
 * booked at this exact (day, period), and their full commitments for the day —
 * so a clash is visible *before* the admin hits save rather than after.
 */
export async function getSlotOptions(sectionId: string, day: DayOfWeek, periodIndex: number) {
  const section = await loadSectionOr404(sectionId);
  const layout = await getTimetableLayout();
  const schedule = scheduleFor(layout, day);

  const [classSubjects, assignments, colors] = await Promise.all([
    prisma.classSubject.findMany({
      where: { classId: section.classId },
      include: { subject: true },
      orderBy: { subject: { name: 'asc' } },
    }),
    prisma.teachingAssignment.findMany({ where: { sectionId }, include: { teacher: { include: { user: true } } } }),
    subjectColorIndexes(),
  ]);
  const assignmentBySubject = new Map(assignments.map((a) => [a.subjectId, a]));
  const teacherIds = [...new Set(assignments.map((a) => a.teacherId))];

  // Where each of those teachers already stands on this day, school-wide.
  const commitmentsByTeacher = new Map<string, { periodIndex: number; className: string; sectionName: string; sectionId: string; subjectName: string }[]>();
  if (teacherIds.length > 0) {
    const [daySlots, teacherAssignments] = await Promise.all([
      prisma.timetableSlot.findMany({
        where: { day },
        include: { section: { include: { class: true } }, subject: true },
      }),
      prisma.teachingAssignment.findMany({ where: { teacherId: { in: teacherIds } } }),
    ]);
    // A slot's teacher is whoever is assigned that subject in that section.
    const teacherOfSlot = new Map(teacherAssignments.map((a) => [`${a.sectionId}:${a.subjectId}`, a.teacherId]));
    for (const slot of daySlots) {
      const teacherId = teacherOfSlot.get(`${slot.sectionId}:${slot.subjectId}`);
      if (!teacherId) continue;
      const list = commitmentsByTeacher.get(teacherId) ?? [];
      list.push({
        periodIndex: slot.periodIndex,
        className: slot.section.class.name,
        sectionName: slot.section.name,
        sectionId: slot.sectionId,
        subjectName: slot.subject.name,
      });
      commitmentsByTeacher.set(teacherId, list);
    }
  }

  const periodTime = (index: number) => {
    const def = schedule?.periods[index - 1];
    return def ? { start: def.start, end: def.end } : null;
  };

  // Sections already sharing this exact period with us as a combined lesson.
  // They run the SAME lesson, so the teacher being "in" both is not a clash.
  const ownSlot = await prisma.timetableSlot.findUnique({
    where: { sectionId_day_periodIndex: { sectionId, day, periodIndex } },
  });
  const partnerSectionIds = new Set<string>();
  if (ownSlot?.groupId) {
    const partners = await prisma.timetableSlot.findMany({
      where: { groupId: ownSlot.groupId, sectionId: { not: sectionId } },
      select: { sectionId: true },
    });
    for (const p of partners) partnerSectionIds.add(p.sectionId);
  }

  // ---- Combined-class candidates -------------------------------------------
  // A section can join only if the SAME teacher takes the SAME subject there.
  const combinableBySubject = new Map<
    string,
    { sectionId: string; sectionName: string; className: string }[]
  >();
  if (assignments.length > 0) {
    const siblings = await prisma.teachingAssignment.findMany({
      where: {
        sectionId: { not: sectionId },
        // Only other sections of the SAME class: combining Class 1 with Class 7
        // makes no sense even when one teacher covers both.
        section: { classId: section.classId },
        OR: assignments.map((a) => ({ subjectId: a.subjectId, teacherId: a.teacherId })),
      },
      include: { section: { include: { class: true } } },
    });
    for (const sib of siblings) {
      const list = combinableBySubject.get(sib.subjectId) ?? [];
      list.push({
        sectionId: sib.sectionId,
        sectionName: sib.section.name,
        className: sib.section.class.name,
      });
      combinableBySubject.set(sib.subjectId, list);
    }
    for (const list of combinableBySubject.values()) {
      list.sort((a, b) => a.className.localeCompare(b.className) || a.sectionName.localeCompare(b.sectionName));
    }
  }

  // What those candidate sections already have booked in this exact period.
  const candidateIds = [...new Set([...combinableBySubject.values()].flat().map((c) => c.sectionId))];
  const occupiedBySection = new Map<string, { subjectName: string; groupId: string | null }>();
  if (candidateIds.length > 0) {
    const busy = await prisma.timetableSlot.findMany({
      where: { day, periodIndex, sectionId: { in: candidateIds } },
      include: { subject: true },
    });
    for (const b of busy) {
      occupiedBySection.set(b.sectionId, { subjectName: b.subject.name, groupId: b.groupId });
    }
  }

  return {
    sectionId: section.id,
    day,
    periodIndex,
    period: periodTime(periodIndex),
    options: classSubjects.map((cs) => {
      const assignment = assignmentBySubject.get(cs.subjectId);
      const teacher = assignment
        ? { id: assignment.teacher.id, fullName: assignment.teacher.user.fullName, status: assignment.teacher.status }
        : null;

      const commitments = (teacher ? (commitmentsByTeacher.get(teacher.id) ?? []) : [])
        .map((c) => ({
          ...c,
          ...(periodTime(c.periodIndex) ?? { start: '', end: '' }),
          isThisSection: c.sectionId === sectionId,
          /** Part of the same combined lesson as this section, not a conflict. */
          isCombinedWithThis: c.periodIndex === periodIndex && partnerSectionIds.has(c.sectionId),
        }))
        .sort((a, b) => a.periodIndex - b.periodIndex);

      // Busy only counts if it's some OTHER, unrelated section at this period.
      const clash =
        commitments.find((c) => c.periodIndex === periodIndex && !c.isThisSection && !c.isCombinedWithThis) ?? null;

      return {
        subjectId: cs.subject.id,
        subjectName: cs.subject.name,
        color: colors.get(cs.subject.id) ?? BUILT_IN_COLORS[0],
        teacher,
        clash,
        commitments,
        // Sections this lesson could be taught to at the same time (same teacher,
        // same subject), each with whatever they already have booked here.
        combinable: (combinableBySubject.get(cs.subjectId) ?? []).map((c) => ({
          ...c,
          occupied: occupiedBySection.get(c.sectionId) ?? null,
        })),
      };
    }),
  };
}

/**
 * Every OTHER section's slot at the same (day, period) taught by `teacherId`.
 * Sections in `sameGroup` are excluded: a combined class is the same lesson in
 * two rooms, not the teacher being in two places at once.
 */
async function findTeacherClashes(
  teacherId: string,
  day: DayOfWeek,
  periodIndex: number,
  excludeSectionIds: string[],
) {
  const others = await prisma.timetableSlot.findMany({
    where: { day, periodIndex, sectionId: { notIn: excludeSectionIds } },
    include: { section: { include: { class: true } }, subject: true },
  });
  if (others.length === 0) return [];

  const assignments = await prisma.teachingAssignment.findMany({
    where: { teacherId, OR: others.map((o) => ({ sectionId: o.sectionId, subjectId: o.subjectId })) },
  });
  const clashKeys = new Set(assignments.map((a) => `${a.sectionId}:${a.subjectId}`));
  return others
    .filter((o) => clashKeys.has(`${o.sectionId}:${o.subjectId}`))
    .map((o) => ({
      slotId: o.id,
      sectionId: o.sectionId,
      className: o.section.class.name,
      sectionName: o.section.name,
      subjectName: o.subject.name,
    }));
}

export interface SetSlotOptions {
  /** Extra sections taught together with this one as a single combined lesson. */
  withSectionIds?: string[];
  /**
   * Resolve conflicts instead of rejecting: frees the teacher by clearing the
   * lessons they'd otherwise be double-booked for, and overwrites whatever the
   * joining sections had in this period.
   */
  force?: boolean;
}

/** Set (or clear, with subjectId null) one cell of the weekly grid. */
export async function setSlot(
  sectionId: string,
  day: DayOfWeek,
  periodIndex: number,
  subjectId: string | null,
  options: SetSlotOptions = {},
) {
  const section = await loadSectionOr404(sectionId);
  const layout = await getTimetableLayout();
  const schedule = scheduleFor(layout, day);
  if (!schedule) {
    throw new AppError(`The school is closed on ${day} — change it in School Setup first`, 400, 'DAY_CLOSED');
  }
  if (periodIndex < 1 || periodIndex > schedule.periods.length) {
    throw new AppError(
      `${day} has ${schedule.periods.length} period${schedule.periods.length === 1 ? '' : 's'} — pick a period between 1 and ${schedule.periods.length}`,
      400,
      'INVALID_PERIOD',
    );
  }

  if (subjectId === null) {
    // Clearing one section of a combined lesson leaves the others intact; if only
    // one remains it is no longer "combined", so drop its group tag.
    const existing = await prisma.timetableSlot.findUnique({
      where: { sectionId_day_periodIndex: { sectionId, day, periodIndex } },
    });
    await prisma.timetableSlot.deleteMany({ where: { sectionId, day, periodIndex } });
    if (existing?.groupId) {
      const remaining = await prisma.timetableSlot.findMany({ where: { groupId: existing.groupId } });
      if (remaining.length <= 1) {
        await prisma.timetableSlot.updateMany({ where: { groupId: existing.groupId }, data: { groupId: null } });
      }
    }
    return getSectionTimetable(sectionId);
  }

  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw NotFound('Subject not found');

  // Every participating section, the primary one first.
  const extraIds = [...new Set(options.withSectionIds ?? [])].filter((id) => id !== sectionId);
  const sections = [section];
  for (const id of extraIds) {
    const extra = await loadSectionOr404(id);
    // A combined class is two sections of the same class sitting together —
    // different year groups can't share a lesson.
    if (extra.classId !== section.classId) {
      throw new AppError(
        `Only sections of the same class can be combined. ${extra.class.name} · Section ${extra.name} is not part of ${section.class.name}.`,
        409,
        'COMBINED_DIFFERENT_CLASS',
      );
    }
    sections.push(extra);
  }

  // The subject must be offered, and the SAME teacher assigned, in every section —
  // a combined lesson is one teacher in one room.
  let teacherId: string | null = null;
  let teacherName = '';
  for (const sec of sections) {
    const offered = await prisma.classSubject.findUnique({
      where: { classId_subjectId: { classId: sec.classId, subjectId } },
    });
    if (!offered) {
      throw new AppError(`${subject.name} is not offered in ${sec.class.name}`, 409, 'SUBJECT_NOT_OFFERED');
    }

    const assignment = await prisma.teachingAssignment.findUnique({
      where: { sectionId_subjectId: { sectionId: sec.id, subjectId } },
      include: { teacher: { include: { user: true } } },
    });
    if (!assignment) {
      throw new AppError(
        `${subject.name} has no teacher assigned in ${sec.class.name} · Section ${sec.name}. Assign a teacher first (Classes → Manage Subjects & Teachers).`,
        409,
        'NO_TEACHER_ASSIGNED',
      );
    }
    if (assignment.teacher.status !== UserStatus.ACTIVE) {
      throw new AppError(
        `${assignment.teacher.user.fullName} (assigned to ${subject.name}) is inactive — reassign the subject before scheduling it.`,
        409,
        'TEACHER_INACTIVE',
      );
    }
    if (teacherId && assignment.teacherId !== teacherId) {
      throw new AppError(
        `A combined class needs one teacher: ${subject.name} is taught by ${teacherName} in ${sections[0].class.name} · Section ${sections[0].name} but by ${assignment.teacher.user.fullName} in ${sec.class.name} · Section ${sec.name}.`,
        409,
        'COMBINED_TEACHER_MISMATCH',
      );
    }
    teacherId = assignment.teacherId;
    teacherName = assignment.teacher.user.fullName;
  }

  const participantIds = sections.map((s) => s.id);
  const clashes = await findTeacherClashes(teacherId!, day, periodIndex, participantIds);
  if (clashes.length > 0) {
    if (!options.force) {
      const first = clashes[0];
      throw new AppError(
        `${teacherName} already teaches ${first.subjectName} in ${first.className} · Section ${first.sectionName} at this time.`,
        409,
        'TEACHER_CLASH',
      );
    }
    // Forced: free the teacher by removing those lessons. Their sections' timetables
    // become incomplete, which their status badge will now report.
    await prisma.timetableSlot.deleteMany({ where: { id: { in: clashes.map((c) => c.slotId) } } });
  }

  const groupId = participantIds.length > 1 ? randomUUID() : null;
  for (const sec of sections) {
    await prisma.timetableSlot.upsert({
      where: { sectionId_day_periodIndex: { sectionId: sec.id, day, periodIndex } },
      update: { subjectId, groupId },
      create: { sectionId: sec.id, day, periodIndex, subjectId, groupId },
    });
    // Joining sections need a repeat window too, or they'd read as "not set".
    if (sec.id !== sectionId && !sec.timetableFrom) {
      const today = pktDay();
      await prisma.section.update({
        where: { id: sec.id },
        data: {
          timetableFrom: today,
          timetableUntil: new Date(today.getTime() + (DEFAULT_REPEAT_DAYS - 1) * 86_400_000),
        },
      });
    }
  }

  // First time this section is scheduled: start the repeat window today and run
  // it for a week. Admins can extend it afterwards.
  if (!section.timetableFrom) {
    const today = pktDay();
    await prisma.section.update({
      where: { id: sectionId },
      data: {
        timetableFrom: today,
        timetableUntil: new Date(today.getTime() + (DEFAULT_REPEAT_DAYS - 1) * 86_400_000),
      },
    });
  }

  return getSectionTimetable(sectionId);
}

// ---------------------------------------------------------------------------
// Teacher self view — their own weekly schedule across sections
// ---------------------------------------------------------------------------

export async function getTeacherTimetable(userId: string) {
  const profile = await prisma.teacherProfile.findUnique({ where: { userId } });
  if (!profile) throw NotFound('Teacher profile not found');

  const assignments = await prisma.teachingAssignment.findMany({ where: { teacherId: profile.id } });
  const layout = await getTimetableLayout();
  const base = {
    days: layout.openDays,
    schedules: layout.schedules,
    maxPeriods: layout.maxPeriods,
  };
  if (assignments.length === 0) return { ...base, slots: [] };

  const [slots, colors] = await Promise.all([
    prisma.timetableSlot.findMany({
      where: { OR: assignments.map((a) => ({ sectionId: a.sectionId, subjectId: a.subjectId })) },
      include: { subject: true, section: { include: { class: true } } },
    }),
    subjectColorIndexes(),
  ]);

  return {
    ...base,
    slots: slots.map((s) => ({
      day: s.day,
      periodIndex: s.periodIndex,
      subject: { id: s.subject.id, name: s.subject.name, color: colors.get(s.subject.id) ?? BUILT_IN_COLORS[0] },
      section: { id: s.section.id, name: s.section.name, className: s.section.class.name },
    })),
  };
}

// ---------------------------------------------------------------------------
// Parent view — a child's section timetable
// ---------------------------------------------------------------------------

export async function getChildTimetable(userId: string, studentId: string) {
  const parent = await prisma.parentProfile.findUnique({ where: { userId } });
  if (!parent) throw NotFound('Parent profile not found');
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw NotFound('Student not found');
  if (student.parentId !== parent.id) throw Forbidden('This student is not your child');
  return getSectionTimetable(student.sectionId);
}

// ---------------------------------------------------------------------------
// Per-period teacher attendance (marked against the timetable for a date)
// ---------------------------------------------------------------------------

export async function getSectionPeriodAttendance(sectionId: string, dateStr?: string) {
  const section = await loadSectionOr404(sectionId);
  const date = dateStr ? parsePktDay(dateStr) : pktDay();
  const day = dayOfWeekFor(date);
  const layout = await getTimetableLayout();
  const schedule = day ? scheduleFor(layout, day) : undefined;

  const base = {
    sectionId: section.id,
    sectionName: section.name,
    classId: section.classId,
    className: section.class.name,
    date: pktDayString(date),
    day,
    isFuture: isFuturePktDay(date),
  };
  // Sunday, or a weekday the school has been configured closed.
  if (!day || !schedule) return { ...base, periods: [] };

  const [slots, teachers, periodRows, colors] = await Promise.all([
    prisma.timetableSlot.findMany({ where: { sectionId, day }, include: { subject: true } }),
    teacherBySubject(sectionId),
    prisma.teacherPeriodAttendance.findMany({ where: { sectionId, date } }),
    subjectColorIndexes(),
  ]);
  const slotByPeriod = new Map(slots.map((s) => [s.periodIndex, s]));
  const markByPeriod = new Map(periodRows.map((r) => [r.periodIndex, r]));

  // Daily check-in context for every teacher on today's grid.
  const teacherIds = [...new Set([...teachers.values()].map((t) => t.id))];
  const daily = await prisma.teacherAttendance.findMany({ where: { date, teacherId: { in: teacherIds } } });
  const dailyByTeacher = new Map(daily.map((d) => [d.teacherId, d]));

  return {
    ...base,
    periods: schedule.periods.map((p) => {
      const slot = slotByPeriod.get(p.index);
      if (!slot) return { ...p, subject: null, teacher: null, dailyStatus: null, checkInTime: null, status: null };
      const teacher = teachers.get(slot.subjectId) ?? null;
      const dailyRec = teacher ? dailyByTeacher.get(teacher.id) : undefined;
      const mark = markByPeriod.get(p.index);
      return {
        ...p,
        subject: { id: slot.subject.id, name: slot.subject.name, color: colors.get(slot.subject.id) ?? BUILT_IN_COLORS[0] },
        teacher: teacher ? { id: teacher.id, fullName: teacher.fullName, status: teacher.status } : null,
        dailyStatus: dailyRec?.status ?? ('UNMARKED' as const),
        checkInTime: dailyRec?.checkInTime ?? null,
        status: (mark?.status ?? 'UNMARKED') as AttendanceStatus | 'UNMARKED',
      };
    }),
  };
}

export async function markSectionPeriodAttendance(
  actor: Actor,
  sectionId: string,
  dateStr: string,
  records: { periodIndex: number; status: AttendanceStatus }[],
) {
  await loadSectionOr404(sectionId);
  const date = parsePktDay(dateStr);
  if (isFuturePktDay(date)) throw new AppError('Cannot mark attendance for a future date', 400, 'FUTURE_DATE');
  const day = dayOfWeekFor(date);
  if (!day) throw new AppError('This date is a Sunday — there are no periods to mark', 400, 'NO_SCHOOL_DAY');

  const slots = await prisma.timetableSlot.findMany({ where: { sectionId, day } });
  const slotByPeriod = new Map(slots.map((s) => [s.periodIndex, s]));
  const assignments = await prisma.teachingAssignment.findMany({ where: { sectionId } });
  const teacherBySubjectId = new Map(assignments.map((a) => [a.subjectId, a.teacherId]));

  for (const r of records) {
    const slot = slotByPeriod.get(r.periodIndex);
    if (!slot) {
      throw new AppError(`Period ${r.periodIndex} has no scheduled subject on ${day}`, 400, 'INVALID_PERIOD');
    }
    const teacherId = teacherBySubjectId.get(slot.subjectId);
    if (!teacherId) {
      throw new AppError(`Period ${r.periodIndex} has no teacher assigned to its subject`, 409, 'NO_TEACHER_ASSIGNED');
    }
    await prisma.teacherPeriodAttendance.upsert({
      where: { teacherId_date_periodIndex: { teacherId, date, periodIndex: r.periodIndex } },
      update: { status: r.status, sectionId, subjectId: slot.subjectId, markedById: actor.userId },
      create: {
        teacherId,
        date,
        periodIndex: r.periodIndex,
        sectionId,
        subjectId: slot.subjectId,
        status: r.status,
        markedById: actor.userId,
      },
    });
  }

  return getSectionPeriodAttendance(sectionId, dateStr);
}
