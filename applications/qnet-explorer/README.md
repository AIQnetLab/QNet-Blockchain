# QNet Explorer

Revolutionary quantum blockchain explorer with futuristic design and Solana integration.

## Features

- 🌌 Futuristic space-themed design with animated planets
- 🔍 Real-time blockchain exploration
- 💫 Quantum-resistant cryptography visualization
- 🌉 Solana bridge integration
- 📱 Mobile-responsive interface
- ⚡ Lightning-fast performance

## Tech Stack

- **Frontend**: Next.js 15, TypeScript, Tailwind CSS
- **UI Components**: shadcn/ui
- **Animations**: CSS animations, 3D transforms
- **Backend Integration**: QNet API
- **Wallet**: Solana wallet adapter

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- QNet node running locally (optional)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/qnet-explorer.git

# Navigate to frontend directory
cd qnet-explorer/frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

### Environment Variables

Create a `.env.local` file:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com
```

## Development

```bash
# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run linting
npm run lint
```

## Project Structure

```
qnet-explorer/
├── frontend/
│   ├── src/
│   │   ├── app/          # Next.js app directory
│   │   ├── components/   # React components
│   │   ├── lib/         # Utilities and helpers
│   │   └── types/       # TypeScript types
│   ├── public/          # Static assets
│   └── package.json
└── README.md
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.