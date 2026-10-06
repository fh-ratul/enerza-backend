import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import type { IFeederListQuery } from "./feeder.interface";
import { FeederServices } from "./feeder.service";

const createFeeder = catchAsync(async (req: Request, res: Response) => {
	const result = await FeederServices.createFeeder(
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.CREATED,
		success: true,
		message: "Feeder created successfully",
		data: result,
	});
});

const getAllFeeders = catchAsync(async (req: Request, res: Response) => {
	const { data, meta, fromCache } = await FeederServices.getAllFeeders(
		req.query as IFeederListQuery,
	);

	// Lets a client (or the demo) see whether Redis served the response.
	res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Feeders retrieved successfully",
		data,
		meta,
	});
});

const updateFeeder = catchAsync(async (req: Request, res: Response) => {
	const result = await FeederServices.updateFeeder(
		req.params.id as string,
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Feeder updated successfully",
		data: result,
	});
});

const deleteFeeder = catchAsync(async (req: Request, res: Response) => {
	const result = await FeederServices.deleteFeeder(
		req.params.id as string,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Feeder deleted successfully",
		data: result,
	});
});

export const FeederController = {
	createFeeder,
	getAllFeeders,
	updateFeeder,
	deleteFeeder,
};
