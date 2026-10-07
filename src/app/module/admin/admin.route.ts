import { Router } from "express";
import { Role } from "../../../generated/prisma/enums";
import { auth } from "../../middleware/checkAuth";
import { AdminController } from "./admin.controller";

const router = Router();

router.get("/stats", auth(Role.ADMIN), AdminController.getStats);

export const AdminRoutes = router;
