-- AlterTable
ALTER TABLE "outage_reports" ADD COLUMN     "photoUrl" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "profilePhoto" TEXT,
ADD COLUMN     "profilePhotoPublicId" TEXT;
