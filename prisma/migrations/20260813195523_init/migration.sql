-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "imageUrl" TEXT,
    "address" TEXT,
    "rating" REAL,
    "isHiddenGem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "destination" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "preferences" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TripDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    CONSTRAINT "TripDay_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TripActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripDayId" TEXT NOT NULL,
    "placeId" TEXT,
    "placeName" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "timeSlot" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "TripActivity_tripDayId_fkey" FOREIGN KEY ("tripDayId") REFERENCES "TripDay" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TripActivity_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HikingTrail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "osmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "distanceKm" REAL,
    "difficulty" TEXT,
    "elevationGain" INTEGER,
    "description" TEXT,
    "geometry" TEXT NOT NULL,
    "trailType" TEXT NOT NULL DEFAULT 'regional',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "HikingTrail_osmId_key" ON "HikingTrail"("osmId");
