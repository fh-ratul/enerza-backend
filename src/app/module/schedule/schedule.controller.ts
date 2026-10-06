import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import type { IScheduleListQuery } from "./schedule.interface";
import { ScheduleServices } from "./schedule.service";

const createSchedules = catchAsync(async (req: Request, res: Response) => {
	const result = await ScheduleServices.createSchedules(
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.CREATED,
		success: true,
		message: `${result.length} draft schedule(s) created successfully`,
		data: result,
	});
});

const getSchedules = catchAsync(async (req: Request, res: Response) => {
	const { data, meta, fromCache } = await ScheduleServices.getSchedules(
		req.query as IScheduleListQuery,
		req.user as RequestUser,
	);

	// Lets a client (or the demo) see whether Redis served the response.
	res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Schedules retrieved successfully",
		data,
		meta,
	});
});

const updateScheduleStatus = catchAsync(async (req: Request, res: Response) => {
	const result = await ScheduleServices.updateScheduleStatus(
		req.params.id as string,
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: `Schedule ${result.status === "PUBLISHED" ? "published" : "cancelled"} successfully`,
		data: result,
	});
});

const generateSchedules = catchAsync(async (req: Request, res: Response) => {
	const result = await ScheduleServices.generateSchedules(
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: result.dryRun ? httpStatus.OK : httpStatus.CREATED,
		success: true,
		message: result.dryRun
			? "Load-shedding plan generated (dry run: nothing was saved)"
			: `${result.schedulesCreated} load-shedding schedule(s) generated and published`,
		data: result,
	});
});

export const ScheduleController = {
	createSchedules,
	getSchedules,
	updateScheduleStatus,
	generateSchedules,
};
