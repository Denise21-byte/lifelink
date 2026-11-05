# LifeLink - Blood Donation Management and Matching Platform

A simple web application that connects hospitals and blood banks with compatible, eligible blood donors.

**Author:** Dushime Aline Denise 


## Features
- Donor, hospital/blood bank and administrator accounts
- Blood requests with automatic donor matching by blood group and eligibility
- Donor notifications, accept/decline, and donation history
- Blood stock management and donor search
- Admin dashboard for managing users

## Tech stack
Node.js, Express, PostgreSQL, HTML/CSS/JavaScript

## Run it locally
1. Install Node.js and PostgreSQL.
2. Install dependencies:
   ```
   npm install
   ```
3. Create the database and tables:
   ```
   psql -U postgres -c "CREATE DATABASE lifelink;"
   psql -U postgres -d lifelink -f db.sql
   ```
4. Copy `.env.example` to `.env` and fill in your Postgres password.
5. Start the server:
   ```
   node server.js
   ```
6. Open http://localhost:3000

The administrator account is created automatically on first start, using `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`.