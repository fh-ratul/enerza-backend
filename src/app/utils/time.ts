// Bangladesh is UTC+6 all year round (no DST), so Asia/Dhaka is a fixed
// offset and no timezone library is needed. Everything is stored in UTC.

export const DHAKA_OFFSET = "+06:00";
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const DHAKA_OFFSET_MS = 6 * HOUR_MS;

// "2026-10-06T16:00", optional seconds/millis, optional Z or ±hh:mm offset.
export const DATE_TIME_REGEX =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

const HAS_OFFSET_REGEX = /(Z|[+-]\d{2}:\d{2})$/;

// A datetime without an offset is Dhaka wall-clock time; one with an explicit
// offset (or Z) is taken as is. Returns an Invalid Date for garbage input.
export const parseDhakaDateTime = (value: string): Date => {
	const trimmed = value.trim();

	if (!DATE_TIME_REGEX.test(trimmed)) {
		return new Date(Number.NaN);
	}

	return new Date(
		HAS_OFFSET_REGEX.test(trimmed) ? trimmed : `${trimmed}${DHAKA_OFFSET}`,
	);
};

// Shifts an instant so that its UTC fields read as Dhaka wall-clock time.
const toDhakaClock = (date: Date) => new Date(date.getTime() + DHAKA_OFFSET_MS);

// "YYYY-MM-DD" in Dhaka
export const toDhakaDateString = (date: Date): string =>
	toDhakaClock(date).toISOString().slice(0, 10);

// "YYYY-MM" in Dhaka
export const toDhakaMonthString = (date: Date): string =>
	toDhakaClock(date).toISOString().slice(0, 7);

// "HH:mm" in Dhaka
export const toDhakaTimeString = (date: Date): string =>
	toDhakaClock(date).toISOString().slice(11, 16);

// "YYYY-MM-DD HH:mm" in Dhaka
export const formatDhaka = (date: Date): string =>
	`${toDhakaDateString(date)} ${toDhakaTimeString(date)}`;

// The UTC instants that bound one Dhaka calendar day: [start, end)
export const dhakaDayRange = (day: string | Date) => {
	const dateString = typeof day === "string" ? day : toDhakaDateString(day);
	const start = new Date(`${dateString}T00:00:00${DHAKA_OFFSET}`);

	return { start, end: new Date(start.getTime() + DAY_MS) };
};

// The UTC instants that bound one Dhaka calendar month ("YYYY-MM"): [start, end)
export const dhakaMonthRange = (month: string) => {
	const [year, monthNumber] = month.split("-").map(Number);
	const nextMonth =
		monthNumber === 12
			? `${year + 1}-01`
			: `${year}-${String(monthNumber + 1).padStart(2, "0")}`;

	return {
		start: new Date(`${month}-01T00:00:00${DHAKA_OFFSET}`),
		end: new Date(`${nextMonth}-01T00:00:00${DHAKA_OFFSET}`),
	};
};

// A Dhaka date plus an hour of that day (0–24, fractions allowed) as an instant.
export const dhakaDateAtHour = (dateString: string, hour: number): Date =>
	new Date(dhakaDayRange(dateString).start.getTime() + hour * HOUR_MS);

export const addMinutes = (date: Date, minutes: number): Date =>
	new Date(date.getTime() + minutes * MINUTE_MS);

export const addDays = (date: Date, days: number): Date =>
	new Date(date.getTime() + days * DAY_MS);

export const diffMinutes = (start: Date, end: Date): number =>
	Math.round((end.getTime() - start.getTime()) / MINUTE_MS);

// Minutes that the window [start, end) spends inside [rangeStart, rangeEnd).
export const overlapMinutes = (
	start: Date,
	end: Date,
	rangeStart: Date,
	rangeEnd: Date,
): number => {
	const from = Math.max(start.getTime(), rangeStart.getTime());
	const to = Math.min(end.getTime(), rangeEnd.getTime());

	return to > from ? Math.round((to - from) / MINUTE_MS) : 0;
};
