import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { RequestUser } from "../../middleware/checkAuth";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import type { IUserListQuery } from "./user.interface";
import { UserServices } from "./user.service";

const getMyProfile = catchAsync(async (req: Request, res: Response) => {
	const result = await UserServices.getMyProfile(req.user as RequestUser);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Profile retrieved successfully",
		data: result,
	});
});

const updateMyProfile = catchAsync(async (req: Request, res: Response) => {
	const result = await UserServices.updateMyProfile(
		req.user as RequestUser,
		req.body,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Profile updated successfully",
		data: result,
	});
});

const getAllUsers = catchAsync(async (req: Request, res: Response) => {
	const { data, meta } = await UserServices.getAllUsers(
		req.query as IUserListQuery,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Users retrieved successfully",
		data,
		meta,
	});
});

const updateUser = catchAsync(async (req: Request, res: Response) => {
	const result = await UserServices.updateUser(
		req.params.id as string,
		req.body,
		req.user as RequestUser,
		req.ip,
	);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "User updated successfully",
		data: result,
	});
});

export const UserController = {
	getMyProfile,
	updateMyProfile,
	getAllUsers,
	updateUser,
};
