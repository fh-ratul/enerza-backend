import type { IQuery, TMeta } from "../interfaces";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// `sortable` is a whitelist: anything else falls back, so a client can never
// order by (or probe for) a column the endpoint did not intend to expose.
export const paginationHelper = (
	query: IQuery,
	sortable: readonly string[],
	fallback = "createdAt",
) => {
	const page = Math.max(1, Number(query.page) || 1);
	const limit = Math.min(
		MAX_LIMIT,
		Math.max(1, Number(query.limit) || DEFAULT_LIMIT),
	);
	const sortBy = sortable.includes(query.sortBy as string)
		? (query.sortBy as string)
		: fallback;
	const sortOrder: "asc" | "desc" = query.sortOrder === "asc" ? "asc" : "desc";

	return { page, limit, skip: (page - 1) * limit, sortBy, sortOrder };
};

export const buildMeta = (
	page: number,
	limit: number,
	total: number,
): TMeta => ({
	page,
	limit,
	total,
	totalPages: Math.ceil(total / limit),
});
