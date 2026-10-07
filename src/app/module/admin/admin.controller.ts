import type { Request, Response } from "express";
import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import type { IAuditLogListQuery } from "./admin.interface";
import { AdminServices } from "./admin.service";

const getStats = catchAsync(async (_req: Request, res: Response) => {
	const { stats, fromCache } = await AdminServices.getStats();

	// Lets a client (or the demo) see whether Redis served the response.
	res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Dashboard stats retrieved successfully",
		data: stats,
	});
});

const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
	const { data, meta } = await AdminServices.getAuditLogs(
		req.query as IAuditLogListQuery,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Audit logs retrieved successfully",
		data,
		meta,
	});
});

export const AdminController = {
	getStats,
	getAuditLogs,
};
