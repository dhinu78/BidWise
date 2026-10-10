// Paste your Firebase web app settings here:
// Firebase console -> Project settings -> General -> Your apps -> Web app -> SDK setup and configuration -> Config
export const firebaseConfig = {
    apiKey: "AIzaSyD2ANHsWmmmQ03vdNuED_7Sk9qUEBq4Sqs",
    authDomain: "sprintd-hackathon.firebaseapp.com",
    projectId: "sprintd-hackathon",
    storageBucket: "sprintd-hackathon.firebasestorage.app",
    messagingSenderId: "611622857891",
    appId: "1:611622857891:web:d7888f3d55d14a930a6316",
    measurementId: "G-F83RPJ8WSY"
  };

// Optional: only allow Google accounts from these domains, e.g. ["equans.ch"]. Empty = any account.
// (Enforce it in firestore.rules / storage.rules too; this check alone is only cosmetic.)
export const ALLOWED_EMAIL_DOMAINS = [];
