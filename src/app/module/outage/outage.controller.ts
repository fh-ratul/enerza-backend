import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import type { IOutageListQuery } from "./outage.interface";
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

const getOutages = catchAsync(async (req: Request, res: Response) => {
	const { data, meta } = await OutageServices.getOutages(
		req.query as IOutageListQuery,
		req.user as RequestUser,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Outages retrieved successfully",
		data,
		meta,
	});
});

export const OutageController = {
	createOutage,
	getOutages,
};
