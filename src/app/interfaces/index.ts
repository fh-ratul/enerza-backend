export interface IQuery {
	searchTerm?: string;
	page?: string | number;
	limit?: string | number;
	sortOrder?: string;
	sortBy?: string;

	// any other filter fields can be added per module
	[key: string]: unknown;
}

export type TErrorSource = {
	path: string;
	message: string;
};

export type TMeta = {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
};
