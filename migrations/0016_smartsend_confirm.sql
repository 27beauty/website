-- Smart Send: downloading a spreadsheet no longer counts as sent. An order is
-- marked downloaded, and only counts as sent (smartsend_exported_at) once the
-- owner confirms the file went into Smart Send, so a failed or forgotten
-- upload can't make an order drop off the list.
ALTER TABLE orders ADD COLUMN smartsend_downloaded_at TEXT;
