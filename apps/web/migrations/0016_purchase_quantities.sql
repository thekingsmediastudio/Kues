ALTER TABLE mandates ADD COLUMN purchase_items_hash TEXT;
CREATE TABLE mandate_purchase_items (
 mandate_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 line_number INTEGER NOT NULL CHECK(line_number BETWEEN 1 AND 10),
 offer_id TEXT,
 title TEXT NOT NULL,
 merchant_domain TEXT NOT NULL,
 currency TEXT NOT NULL CHECK(length(currency)=3 AND currency=upper(currency)),
 unit_amount_minor INTEGER NOT NULL CHECK(unit_amount_minor BETWEEN 1 AND 100000000),
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 20),
 line_total_minor INTEGER NOT NULL CHECK(line_total_minor=unit_amount_minor*quantity AND line_total_minor<=100000000),
 evidence_hash TEXT NOT NULL,
 PRIMARY KEY(mandate_id,line_number),
 FOREIGN KEY(workspace_id,mandate_id) REFERENCES mandates(workspace_id,id) ON DELETE CASCADE
);
