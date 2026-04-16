# PassBoard

Real-time room-based password sharing for teams in cybersecurity competitions. Access is gated by a UUID room link, and passwords are stored encrypted at rest with a key derived from that room UUID. Still, use at your own risk and do not use PassBoard for any real passwords.

## Features

- Shared room links with no account system
- Name-only join flow for change attribution
- Live updates
- Board naming with shared updates
- Board items with name, port, username, and password
- Password history per item
- One-click copy and direct inline password editing
- Configurable password generator with random and short-word modes
- Global password hide toggle plus JSON import/export

## Security Notes

- Use HTTPS in deployment so the UUID room link and password traffic are encrypted in transit.
- Anyone with the room UUID can access the room, so treat the link as the secret.
- The database stores only encrypted passwords and a hash of the room UUID, not the raw room key.
- Rooms are deleted 7 days from their creation date.
- The built-in password generator is convenience-focused, especially in word mode, so do not assume generated values meet strong cryptographic password requirements.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`, create a room, and share the generated `/room/<uuid>` link.
