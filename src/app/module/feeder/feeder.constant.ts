export const FEEDER_SORTABLE_FIELDS = [
	"createdAt",
	"name",
	"code",
	"loadMW",
	"priority",
] as const;

// `searchTerm` is matched (case-insensitively) against these columns on the
// feeder itself and on each of its areas.
export const FEEDER_SEARCHABLE_FIELDS = ["name", "code"] as const;

export const MAX_AREAS_PER_REQUEST = 20;
