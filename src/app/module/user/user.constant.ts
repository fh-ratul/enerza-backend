export const USER_SORTABLE_FIELDS = [
	"createdAt",
	"name",
	"email",
	"role",
	"status",
] as const;

// `searchTerm` is matched (case-insensitively) against these user columns,
// plus the customer's meter number.
export const USER_SEARCHABLE_FIELDS = ["name", "email"] as const;
