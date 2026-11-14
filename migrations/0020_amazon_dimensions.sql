-- Parcel2Go prices a parcel from its weight and size. Every product had those
-- empty, so every quote used the default box (1kg, 30x20x5cm) whatever was
-- actually being posted — under-paying on a heavy order, over-paying on a
-- small one.
--
-- Amazon already knows the package dimensions of anything listed there, and
-- the sync reads them (fillAmazonDimensions in channels.ts). This records when
-- a product was last asked about, so one that Amazon has no dimensions for is
-- not fetched again on every run, and so the pass can resume where it stopped.
ALTER TABLE products ADD COLUMN dimensions_checked_at TEXT;
