# Digital Key Log / Sistem Peminjaman Kunci Digital

This project is a working prototype based on the provided PRD and design guide. It includes a mobile-first borrower request form, a Security dashboard with real-time updates via Socket.IO, and an Admin dashboard for room and staff management.

The interface uses a local Tailwind CSS build with a restrained navy, gold, and sky palette inspired by the supplied reference image.

## Features

- Mobile borrower form at `/`
- Searchable, multi-select room picker for borrowers
- Security PIN login at `/dashboard/security/login`
- Real-time dashboard at `/dashboard/security/`
- Admin PIN login at `/dashboard/admin/login`
- Admin dashboard at `/dashboard/admin/`
- Admin navigation for room management, security management, and detailed audit logs
- Room and security name editing, plus soft-deleted security reactivation
- Room deactivation and reactivation with loan-history preservation
- Audit timeline with full local timestamps and security staff for request, handoff, and return events
- System activity log for admin/security logins, PIN resets, and room/security management changes
- Branded 404 and 500 error pages, with JSON errors retained for API requests
- Request/borrow/return lifecycle
- Room status updates and audit requests
- Socket.IO live synchronization for dashboard updates

## Quick start

### Docker (recommended for persistent data)

Docker Compose runs the Node app and PostgreSQL. Application data and login sessions are stored in PostgreSQL; PostgreSQL keeps its files in the named `pgdata` Docker volume.

```bash
docker compose up --build -d
docker compose logs -f app
```

Open the app at http://localhost:3000/. To stop the containers without deleting data:

```bash
docker compose down
```

The database volume remains when containers are stopped or recreated. **Do not run `docker compose down -v`** unless you intend to delete the persisted database. The included default database password and PINs are for local development only; set `POSTGRES_PASSWORD`, `SESSION_SECRET`, and `ADMIN_PIN` in an untracked `.env` file before exposing the app or using it beyond local testing.

PostgreSQL stores rooms, security staff, loan transactions, system activity logs, PIN hashes, and express login sessions. PINs are salted and hashed before they are stored.

### Run directly on the host

The app now requires a reachable PostgreSQL instance. Set the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` environment variables (or use the matching local defaults from `docker-compose.yml`) before running:

```bash
npm install
npm run build:css
npm start
```

Run `npm run build:css` again after changing Tailwind styles in `src/input.css` or the EJS templates.

Then open:

- http://localhost:3000/
- http://localhost:3000/dashboard/security/login
- http://localhost:3000/dashboard/admin/login

## Default PINs

- Shared Security PIN: `123456` (resettable from the Admin > Security tab)
- Admin: `000000` (resettable from the Admin > Security tab)

Security staff are managed as names only. Removing a staff member deactivates the entry without deleting it, preserving staff attribution in existing audit logs. All active staff use the shared Security PIN. Resetting either PIN changes the login credential for the current server process. Set `ADMIN_PIN` to customize the initial admin PIN.

## Notes

The Docker Compose setup initializes its schema automatically and seeds the initial rooms and security staff only when the corresponding tables are empty. Application data persists across app/container restarts in PostgreSQL.
