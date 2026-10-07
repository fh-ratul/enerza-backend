import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import { OutageServices } from "./outage.service";

const createOutage = catchAsync(async (req: Request, res: Response) => {
	const { isNew, explanation, ...result } = await OutageServices.createOutage(
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		// 200 when a repeat report only returned the explanation it already had
		statusCode: isNew ? httpStatus.CREATED : httpStatus.OK,
		success: true,
		message: explanation,
		data: result,
	});
});

export const OutageController = {
	createOutage,
};
