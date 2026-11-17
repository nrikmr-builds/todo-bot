-- Example starting list. Replace with your own before running migrations.
INSERT INTO categories (id, name, parent_id, prefix, next_num, position) VALUES
  (1, 'Academics',  NULL, 'A', 4, 1),
  (2, 'Recruiting', NULL, 'R', 4, 2);

INSERT INTO items (category_id, label, text, position) VALUES
  (1, 'A1', 'Finish problem set 3', 1),
  (1, 'A2', 'Read case for Thursday''s strategy class', 2),
  (1, 'A3', 'Book study room for group project', 3),
  (2, 'R1', 'Practice two product-sense cases', 1),
  (2, 'R2', 'Update resume with latest project', 2),
  (2, 'R3', 'Follow up with coffee-chat contacts', 3);
