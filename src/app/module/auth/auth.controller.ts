import type { CookieOptions, Request, Response } from "express";
import httpStatus from "http-status";
import config from "../../config";
import { AppError } from "../../utils/AppError";
import { catchAsync } from "../../utils/catchAsync";
import { sendResponse } from "../../utils/sendResponse";
import { AuthServices } from "./auth.service";

const ACCESS_TOKEN_MAX_AGE = 1000 * 60 * 60 * 24; // 1 day
const REFRESH_TOKEN_MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days

// In production the API and the client live on different origins, so the
// cookies have to be `SameSite=None; Secure`.
const cookieOptions = (maxAge: number): CookieOptions => ({
	httpOnly: true,
	secure: config.is_production,
	sameSite: config.is_production ? "none" : "lax",
	maxAge,
});

const setAccessTokenCookie = (res: Response, accessToken: string) => {
	res.cookie("accessToken", accessToken, cookieOptions(ACCESS_TOKEN_MAX_AGE));
};

const setRefreshTokenCookie = (res: Response, refreshToken: string) => {
	res.cookie(
		"refreshToken",
		refreshToken,
		cookieOptions(REFRESH_TOKEN_MAX_AGE),
	);
};

const register = catchAsync(async (req: Request, res: Response) => {
	const result = await AuthServices.register(req.body);

	setAccessTokenCookie(res, result.accessToken);
	setRefreshTokenCookie(res, result.refreshToken);

	sendResponse(res, {
		statusCode: httpStatus.CREATED,
		success: true,
		message: "Customer registered successfully",
		data: result,
	});
});

const login = catchAsync(async (req: Request, res: Response) => {
	const result = await AuthServices.login(req.body);

	setAccessTokenCookie(res, result.accessToken);
	setRefreshTokenCookie(res, result.refreshToken);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "User logged in successfully",
		data: result,
	});
});

const refreshToken = catchAsync(async (req: Request, res: Response) => {
	const token = req.body.refreshToken ?? req.cookies?.refreshToken;

	if (!token) {
		throw new AppError(httpStatus.UNAUTHORIZED, "Refresh token is missing");
	}

	const result = await AuthServices.refreshToken(token);

	setAccessTokenCookie(res, result.accessToken);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "New access token generated successfully",
		data: result,
	});
});

const googleLogin = catchAsync(async (req: Request, res: Response) => {
	const result = await AuthServices.googleLogin(req.body);

	setAccessTokenCookie(res, result.accessToken);
	setRefreshTokenCookie(res, result.refreshToken);

	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: result.isProfileComplete
			? "User logged in with Google successfully"
			: "Logged in with Google. Please complete your profile (area and meter number)",
		data: result,
	});
});

export const AuthController = {
	register,
	login,
	refreshToken,
	googleLogin,
};
