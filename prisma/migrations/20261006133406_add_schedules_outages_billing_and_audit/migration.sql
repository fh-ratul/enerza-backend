-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('LOAD_SHEDDING', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutageStatus" AS ENUM ('REPORTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutagePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'EXPLAINED', 'RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('UNPAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'SOFT_DELETE', 'STATUS_CHANGE', 'ROLE_CHANGE', 'GENERATE', 'PAYMENT_COMPLETED', 'PAYMENT_FAILED');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actorRole" "Role",
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "billingMonth" TEXT NOT NULL,
    "previousReading" INTEGER NOT NULL,
    "currentReading" INTEGER NOT NULL,
    "unitsConsumed" INTEGER NOT NULL,
    "energyCharge" DECIMAL(10,2) NOT NULL,
    "demandCharge" DECIMAL(10,2) NOT NULL,
    "vatAmount" DECIMAL(10,2) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "BillStatus" NOT NULL DEFAULT 'UNPAID',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outages" (
    "id" TEXT NOT NULL,
    "status" "OutageStatus" NOT NULL DEFAULT 'REPORTED',
    "priority" "OutagePriority" NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "feederId" TEXT NOT NULL,
    "technicianId" TEXT,

    CONSTRAINT "outages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outage_timelines" (
    "id" TEXT NOT NULL,
    "fromStatus" "OutageStatus",
    "toStatus" "OutageStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outageId" TEXT NOT NULL,
    "changedById" TEXT,

    CONSTRAINT "outage_timelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outage_reports" (
    "id" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "outageId" TEXT,
    "scheduleId" TEXT,

    CONSTRAINT "outage_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "invoiceNumber" TEXT NOT NULL,
    "bkashPaymentId" TEXT,
    "bkashTrxId" TEXT,
    "paidAt" TIMESTAMP(3),
    "gatewayResponse" JSONB,
    "requiresRefund" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "billId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "type" "ScheduleType" NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'DRAFT',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "batchId" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "feederId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bills_billNumber_key" ON "bills"("billNumber");

-- CreateIndex
CREATE INDEX "bills_status_dueDate_idx" ON "bills"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "bills_customerId_billingMonth_key" ON "bills"("customerId", "billingMonth");

-- CreateIndex
CREATE INDEX "outages_feederId_status_idx" ON "outages"("feederId", "status");

-- CreateIndex
CREATE INDEX "outages_status_priority_createdAt_idx" ON "outages"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "outages_technicianId_status_idx" ON "outages"("technicianId", "status");

-- CreateIndex
CREATE INDEX "outage_timelines_outageId_createdAt_idx" ON "outage_timelines"("outageId", "createdAt");

-- CreateIndex
CREATE INDEX "outage_reports_customerId_status_idx" ON "outage_reports"("customerId", "status");

-- CreateIndex
CREATE INDEX "outage_reports_outageId_idx" ON "outage_reports"("outageId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_invoiceNumber_key" ON "payments"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payments_bkashPaymentId_key" ON "payments"("bkashPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_bkashTrxId_key" ON "payments"("bkashTrxId");

-- CreateIndex
CREATE INDEX "payments_billId_status_idx" ON "payments"("billId", "status");

-- CreateIndex
CREATE INDEX "payments_customerId_createdAt_idx" ON "payments"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "schedules_feederId_startTime_endTime_idx" ON "schedules"("feederId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "schedules_status_startTime_idx" ON "schedules"("status", "startTime");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outages" ADD CONSTRAINT "outages_feederId_fkey" FOREIGN KEY ("feederId") REFERENCES "feeders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outages" ADD CONSTRAINT "outages_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outage_timelines" ADD CONSTRAINT "outage_timelines_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "outages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outage_timelines" ADD CONSTRAINT "outage_timelines_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outage_reports" ADD CONSTRAINT "outage_reports_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outage_reports" ADD CONSTRAINT "outage_reports_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outage_reports" ADD CONSTRAINT "outage_reports_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "outages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outage_reports" ADD CONSTRAINT "outage_reports_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_billId_fkey" FOREIGN KEY ("billId") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_feederId_fkey" FOREIGN KEY ("feederId") REFERENCES "feeders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
