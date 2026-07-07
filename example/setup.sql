-- Run this against your test MySQL before starting the demo service:
--   mysql -h 127.0.0.1 -u root -p < demo/sql/setup.sql

CREATE DATABASE IF NOT EXISTS mysql_demo
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE mysql_demo;

DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  balance_cents INT NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  amount_cents INT NOT NULL,
  status      VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO users (email, name, balance_cents) VALUES
  ('alice@example.com', 'Alice', 10000),
  ('bob@example.com',   'Bob',    5000),
  ('carol@example.com', 'Carol',  2500);

INSERT INTO orders (user_id, amount_cents, status) VALUES
  (1, 1500, 'paid'),
  (1, 2300, 'pending'),
  (2, 800,  'paid');

DROP PROCEDURE IF EXISTS get_user_summary;

DELIMITER $$
CREATE PROCEDURE get_user_summary(IN p_user_id INT)
BEGIN
  SELECT id, email, name, balance_cents
    FROM users
   WHERE id = p_user_id;

  SELECT COUNT(*) AS order_count,
         COALESCE(SUM(amount_cents), 0) AS total_cents
    FROM orders
   WHERE user_id = p_user_id;
END$$
DELIMITER ;
