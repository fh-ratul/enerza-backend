import nodemailer from "nodemailer";
import config from "../config";

// Gmail SMTP with an app password. The timeouts keep a slow mail server from
// holding a request open: email here is a notification, never a requirement.
export const transporter = nodemailer.createTransport({
	service: "gmail",
	auth: {
		user: config.smtp_user,
		pass: config.smtp_password,
	},
	connectionTimeout: 8_000,
	greetingTimeout: 8_000,
	socketTimeout: 10_000,
});
