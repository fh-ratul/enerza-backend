import type { Request, Response } from "express";
import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
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

export const AdminController = {
	getStats,
};
