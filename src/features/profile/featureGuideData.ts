// Feature Guide content - shared by the in-app guide (/feature-guide), the
// public guide (/guide) and the landing page's guide section. Screens live in
// public/guide/<image>.jpg.

export interface Feature {
  id: string
  title: string
  summary: string
  image: string
  /** Extra screens shown under the main one. */
  more?: string[]
  steps: string[]
  /** Where "Open" takes the user (omitted when they're already past it). */
  path?: string
}
export interface Section {
  heading: string
  features: Feature[]
}

export const SECTIONS: Section[] = [
  {
    heading: 'Getting started',
    features: [
      {
        id: 'sign-in', title: 'Sign in', image: 'auth',
        summary: 'Open MeshPort with Google, a one-time email code, or a wallet you already have.',
        steps: [
          'Tick the box to accept the Terms and Privacy Policy.',
          'Choose Continue with Google or Continue with Email OTP - no password needed.',
          'Prefer a classic wallet? Create New Wallet gives you 12 secret words; Import Existing Wallet uses yours.',
          'Pick a .arc username and set a 6-digit passcode. That’s it.',
        ],
      },
      {
        id: 'self-custody', title: 'Your wallet is yours', image: 'security', path: '/security',
        summary: 'Every wallet is self-custodial. The key is made on your phone and never sent to MeshPort.',
        steps: [
          'With Google or email, add a passkey (Face ID, fingerprint or device PIN) when asked.',
          'Save your Recovery QR and remember its password - it brings your wallet back on a new phone.',
          'On a new device, sign in, then unlock with your passkey or scan the Recovery QR.',
          'MeshPort never stores your private key, recovery password or secret words.',
        ],
      },
    ],
  },
  {
    heading: 'Money',
    features: [
      {
        id: 'home', title: 'Home', image: 'home', path: '/',
        summary: 'Your balance, quick actions, recent people and every asset at a glance.',
        steps: [
          'The top card shows your Available Balance. Tap the eye to hide amounts.',
          'Swipe the card to see the Multichain Hub: money you can bring from other chains.',
          'Pay, Receive, Swap and More are one tap away.',
          'Tap an asset (USDC, EURC, cirBTC) to see its history.',
        ],
      },
      {
        id: 'pay', title: 'Pay', image: 'pay', path: '/pay',
        summary: 'Send money to a username, a wallet address, or someone you’ve paid before.',
        steps: [
          'Tap Pay, then pick a recent person, a contact, or search a username / 0x address.',
          'Type the amount and choose the currency.',
          'Confirm with your passcode or fingerprint. It arrives in about a second.',
        ],
      },
      {
        id: 'receive', title: 'Receive', image: 'receive', path: '/receive',
        summary: 'Your QR code, username and payment link - everything someone needs to pay you.',
        steps: [
          'Show your QR for someone to scan, or tap Share QR / Download QR.',
          'Request payment adds an amount to the QR and link.',
          'Copy your username or wallet address with one tap.',
          'Share Payment Link sends a link that opens straight to paying you.',
        ],
      },
      {
        id: 'scan', title: 'Scan to pay', image: 'scanner', path: '/scanner',
        summary: 'Pay anyone by pointing your camera at their MeshPort, wallet or shop QR.',
        steps: [
          'Tap the round scan button in the middle of the bottom bar.',
          'Point your camera at the QR - or upload a photo of one, or enter details by hand.',
          'Check who you’re paying and the amount, then confirm.',
        ],
      },
      {
        id: 'payment-links', title: 'Payment links', image: 'paylink',
        summary: 'A link like meshport.xyz/paylink/you?amount=10 that anyone can open to pay you.',
        steps: [
          'Create one from Receive (with or without an amount) and share it in any chat.',
          'The preview card shows your name and the amount, e.g. “Pay $10”.',
          'The person taps Pay - even if they don’t have MeshPort yet.',
        ],
      },
      {
        id: 'swap', title: 'Swap', image: 'swap', path: '/swap',
        summary: 'Exchange USDC, EURC and cirBTC inside the app.',
        steps: [
          'Choose what you pay and what you receive.',
          'Type an amount - you see what you’ll receive and the live rate (e.g. 1 USDC ≈ 0.99 EURC) before you confirm.',
          'Tap Swap USDC → EURC. Your recent swaps are listed below with their status.',
        ],
      },
      {
        id: 'activity', title: 'Activity', image: 'activity', path: '/activity',
        summary: 'Every payment, swap and transfer, grouped by day and searchable.',
        steps: [
          'Search by username, wallet address or transaction hash.',
          'Use the filter button to show only payments, swaps, multichain moves and more.',
          'Tap any row for full details and a link to the block explorer.',
        ],
      },
      {
        id: 'insights', title: 'Insights', image: 'insights', path: '/insights',
        summary: 'A simple picture of your money: totals, top contacts and trends.',
        steps: [
          'Switch between this week, this month and this year.',
          'See what you paid, received, your net flow and who you pay most.',
          'The activity chart shows how busy each day, week or month was.',
        ],
      },
    ],
  },
  {
    heading: 'Chat',
    features: [
      {
        id: 'chat', title: 'Chat & pay', image: 'chat', more: ['convo'], path: '/chat',
        summary: 'Message friends and send money in the same conversation. Chats are end-to-end encrypted.',
        steps: [
          'Open Chats and pick a conversation, or tap the pencil to start a new one.',
          'Type a message, or tap Pay at the top to send money - it shows in the chat as a payment card marked “Confirmed on Arc”.',
          'Tap the paperclip for Camera, Gallery, Document, File or Pay.',
          'Ticks show your message was delivered and read.',
          'Only you and the other person can read the chat - not even MeshPort.',
        ],
      },
    ],
  },
  {
    heading: 'Multichain',
    features: [
      {
        id: 'hub', title: 'Multichain Hub - Transfer', image: 'multichain', path: '/multichain',
        summary: 'Send USDC from your MeshPort balance to a wallet on another blockchain.',
        steps: [
          'The ticket shows what you can transfer (on Arc) and bring (on other chains).',
          'Pick a destination chain and route - Unified Balance or CCTP.',
          'Enter the recipient address (or Use my address) and amount, then confirm.',
          'Track every step in the Activity tab.',
        ],
      },
      {
        id: 'bring', title: 'Bring funds', image: 'bring', path: '/multichain?tab=bring',
        summary: 'Move USDC sitting on other chains into your MeshPort balance.',
        steps: [
          'Open the Bring tab - MeshPort checks about 20 chains for you.',
          'Each chain with money shows its balance.',
          'Select a chain and bring the funds to Arc in one step.',
        ],
      },
      {
        id: 'recover', title: 'Recover funds', image: 'recover', path: '/multichain?tab=recovery',
        summary: 'If a cross-chain move ever gets stuck, finish or reverse it here.',
        steps: [
          'Open the Recover tab in the Multichain Hub.',
          'Anything stuck is listed with what happened.',
          'Tap to finish it - or see “Nothing stuck” when all is well.',
        ],
      },
    ],
  },
  {
    heading: 'More tools',
    features: [
      {
        id: 'bulk', title: 'Bulk payout', image: 'bulk', path: '/bulk-payout',
        summary: 'Pay many people in a single transaction.',
        steps: [
          'Add recipients one by one, or upload a CSV of usernames and amounts.',
          'Add an optional purpose (e.g. “March salaries”).',
          'Review the total and confirm once - everyone is paid together.',
        ],
      },
      {
        id: 'rewards', title: 'Rewards', image: 'rewards', path: '/rewards',
        summary: 'Earn points when you pay, then turn them into USDC.',
        steps: [
          'Every payment earns points, up to a daily limit (see How to Earn).',
          'Once you have enough, choose how many points to claim.',
          'Tap Claim - the USDC lands in your balance.',
        ],
      },
      {
        id: 'p2p', title: 'P2P marketplace', image: 'p2p', path: '/p2p',
        summary: 'Buy and sell USDC with other people, protected by escrow.',
        steps: [
          'Browse offers in Buy USDC or Sell USDC, and filter by payment method.',
          'Open an offer to start a trade - the USDC is held in escrow.',
          'Funds are released only when both sides confirm. Create your own offer any time.',
        ],
      },
      {
        id: 'merchant', title: 'Merchant account', image: 'merchant', path: '/merchant',
        summary: 'Take payments as a business, with bills, order numbers and a ledger.',
        steps: [
          'Apply with your business name and type.',
          'Once approved, send bills and payment requests with an order number.',
          'Customers can pay from any supported chain; it lands in your Arc wallet.',
        ],
      },
      {
        id: 'notifications', title: 'Notifications', image: 'notifications', path: '/notifications',
        summary: 'Payments received, rewards and trade updates in one place.',
        steps: [
          'Tap the bell on Home to see money received, points earned and trade updates, newest first.',
          'Tap Clear to empty the list.',
          'Allow notifications when asked to hear about payments even when the app is closed.',
        ],
      },
    ],
  },
  {
    heading: 'Account',
    features: [
      {
        id: 'profile', title: 'Profile', image: 'profile', path: '/profile',
        summary: 'Your name, photo, username and every setting.',
        steps: [
          'Edit Profile changes your photo and display name.',
          'Share sends your profile; Copy copies your wallet address.',
          'Settings, backup, appearance and help are all listed here.',
        ],
      },
      {
        id: 'security', title: 'Security', image: 'security', path: '/security',
        summary: 'Passkeys, Recovery QR, passcode and fingerprint unlock.',
        steps: [
          'Wallet shows your address - tap the copy icon to copy it.',
          'Recovery shows your passkeys (with the device each was added on) and when your Recovery QR was saved. Manage adds a passkey or makes a new QR.',
          'App lock turns fingerprint login and Passcode Lock on or off, and changes your 6-digit passcode.',
          'Lock Now locks the app straight away.',
        ],
      },
      {
        id: 'backup', title: 'Backup', image: 'backup', path: '/backup',
        summary: 'For created or imported wallets: view your secret words or private key.',
        steps: [
          'Enter your passcode to reveal them.',
          'Write them down on paper - never screenshot or share them.',
        ],
      },
      {
        id: 'appearance', title: 'Appearance', image: 'appearance', path: '/appearance',
        summary: 'Light, dark, or follow your device.',
        steps: ['Pick System, Light or Dark - it changes instantly.'],
      },
      {
        id: 'help', title: 'Help & support', image: 'help', path: '/help-support',
        summary: 'Tell us about a problem and follow the reply.',
        steps: [
          'Choose a topic, describe what happened and tap Submit ticket.',
          'Your tickets and their answers appear below.',
        ],
      },
    ],
  },
]
