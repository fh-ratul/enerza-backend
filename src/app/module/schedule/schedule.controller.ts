import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
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

export const ScheduleController = {
	createSchedules,
};
