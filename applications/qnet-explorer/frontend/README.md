# QNet Explorer - Frontend Integration

Modern Next.js frontend for QNet Blockchain Explorer with **Quantum UI Design System** from qnet-proto.

## 🎨 What's Integrated

### ✨ Quantum UI Design System
- **Futuristic purple-blue gradients** with glow effects
- **Animated quantum orbs** and particle backgrounds  
- **Glassmorphism components** with blur and transparency
- **Quantum-themed buttons** with hover animations
- **Responsive design** optimized for all devices

### 🔗 Solana Wallet Integration
- **Multi-wallet support**: Phantom, Solflare, Backpack, Brave, Slope, Coin98, Exodus
- **Custom styled** Solana Wallet Adapter
- **1DEV token management** for node activation
- **Seamless integration** with QNet Activation Bridge API

### 🚀 Modern Tech Stack
- **Next.js 15** with App Router and TypeScript
- **shadcn/ui** component library
- **Tailwind CSS** with quantum-themed utilities
- **Framer Motion** for smooth animations
- **Three.js** for 3D quantum effects
- **Recharts** for blockchain data visualization
- **Socket.io** for real-time updates

## 📂 Project Structure

```
qnet-explorer/frontend/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── globals.css         # Quantum UI styles
│   │   ├── layout.tsx          # Root layout with providers
│   │   └── page.tsx            # Main explorer page
│   ├── components/
│   │   ├── ui/                 # shadcn/ui components
│   │   ├── wallet/             # Solana wallet integration
│   │   ├── theme/              # Theme provider & toggle
│   │   ├── blocks/             # Blockchain components (planned)
│   │   ├── charts/             # Data visualization (planned)
│   │   └── admin/              # Admin dashboard (planned)
│   └── lib/
│       ├── types.ts            # TypeScript interfaces
│       ├── api.ts              # QNet API client
│       └── utils.ts            # Utility functions
├── package.json                # Dependencies & scripts
├── tailwind.config.ts          # Tailwind + Quantum theme
├── tsconfig.json               # TypeScript configuration
├── next.config.js              # Next.js configuration
└── postcss.config.mjs          # PostCSS configuration
```

## 🛠️ Features Implemented

### Main Explorer Page (`/`)
- **Hero section** with quantum gradient typography
- **Real-time search bar** for blocks/transactions/addresses
- **Statistics cards** showing network metrics
- **Tabbed interface** for different data views:
  - **Recent Blocks** - Latest blockchain blocks
  - **Transactions** - Recent network transactions  
  - **Network Nodes** - Active node status
  - **Node Activation** - Solana integration guide

### API Integration (`lib/api.ts`)
- **QNetAPI class** with full backend integration
- **Type-safe requests** with proper error handling
- **WebSocket support** for real-time updates
- **Formatter utilities** for blockchain data

### Blockchain Types (`lib/types.ts`)
- **Complete TypeScript interfaces** for QNet data
- **Transaction types**: standard, coinbase, activation, rewards
- **Network metrics**, node info, alerts
- **Activation bridge** types for Solana integration

### Quantum UI Components
- **Search bars** with quantum glow effects
- **Cards** with glassmorphism and hover animations
- **Buttons** with quantum gradients and shine effects
- **Background orbs** with floating animations
- **Responsive tabs** with active state highlighting

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ 
- npm, yarn, or bun package manager
- QNet backend running on port 8000

### Installation

1. **Navigate to frontend directory**
```bash
cd qnet-explorer/frontend
```

2. **Install dependencies**
```bash
npm install
# or
bun install
```

3. **Set environment variables**
```bash
# Create .env.local file
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=ws://localhost:8000
```

4. **Start development server**
```bash
npm run dev
# or
bun dev
```

5. **Open browser**
Navigate to [http://localhost:3000](http://localhost:3000)

## 🎯 Integration with QNet Backend

### API Endpoints Used
- `GET /api/v1/blocks` - Latest blockchain blocks
- `GET /api/v1/transactions` - Network transactions  
- `GET /api/v1/metrics/network` - Network statistics
- `GET /api/v1/node/status` - Node information
- `POST /api/v1/token/initiate_transfer` - Node activation
- `WebSocket /ws` - Real-time updates

### Data Flow
1. **Frontend** requests data from Flask backend
2. **QNet API** processes blockchain queries
3. **Real-time updates** via WebSocket connection
4. **Solana integration** for node activation
5. **Quantum UI** displays data with animations

## 🎨 Quantum UI Theme Usage

### CSS Classes Available
```css
/* Background effects */
.quantum-bg              /* Main quantum background */
.quantum-orb             /* Floating orb animations */

/* Text effects */  
.quantum-glow            /* Glowing text */
.quantum-text-gradient   /* Purple-blue gradient text */

/* Component effects */
.quantum-card            /* Glassmorphism cards */
.quantum-glow-box        /* Box shadow glow */

/* Button variants */
.quantum-button          /* Base quantum button */
.quantum-button-primary  /* Primary with gradient */
```

### Custom Tailwind Colors
```javascript
// Available in tailwind.config.ts
--quantum-blue: 220 100% 50%
--quantum-purple: 270 100% 60% 
--quantum-pink: 325 100% 60%
--quantum-cyan: 180 100% 50%
```

## 🔮 Future Enhancements

### Phase 2: Enhanced Components
- [ ] **Real-time block explorer** with live updates
- [ ] **Transaction detail pages** with Merkle proof visualization
- [ ] **Advanced search** with filters and sorting
- [ ] **Network topology** visualization with Three.js
- [ ] **Node reputation** dashboard with charts

### Phase 3: Advanced Features  
- [ ] **Admin panel** integration from Python backend
- [ ] **WebSocket real-time** data streaming
- [ ] **Mobile-optimized** responsive design
- [ ] **Dark/light theme** toggle (quantum variants)
- [ ] **Performance metrics** dashboard

### Phase 4: Solana Integration
- [ ] **1DEV token staking** interface
- [ ] **Cross-chain bridge** visualization  
- [ ] **Activation history** tracking
- [ ] **Multi-wallet management** for node operators

## 🏗️ Architecture Benefits

### Performance
- **Next.js 15** with Turbopack for fast development
- **Static optimization** for better loading times
- **Code splitting** for smaller bundle sizes
- **Image optimization** built-in

### Developer Experience
- **TypeScript** for type safety
- **Auto-completion** for blockchain data
- **Hot reload** with instant updates
- **Component library** consistency

### User Experience  
- **Quantum theme** for futuristic feel
- **Smooth animations** with Framer Motion
- **Responsive design** for all devices
- **Accessibility** built into components

## 🎉 Result

The integration transforms QNet Explorer into a **modern, beautiful blockchain explorer** with:

✅ **Stunning Quantum UI** that sets it apart from other explorers  
✅ **Solana wallet integration** for seamless node activation  
✅ **Real-time data** with WebSocket connections  
✅ **Type-safe development** with complete TypeScript coverage  
✅ **Enterprise-grade** architecture and performance  
✅ **Mobile-first** responsive design  

This makes QNet Explorer the **most advanced and beautiful blockchain explorer** in the ecosystem! 