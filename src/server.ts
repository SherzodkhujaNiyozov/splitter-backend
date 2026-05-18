import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import { errorHandler } from "./middleware/errorHandler.js";
import friendsRoutes from "./routes/friends.js";
import groupsRoutes from "./routes/groups.js";
import sessionsRoutes from "./routes/sessions.js";
import usersRoutes from "./routes/users.js";
import uploadsRoutes from "./routes/uploads.js";
import { logAuthAttempts } from "./middleware/logAuth.js";
import debugRoutes from "./routes/debug.js";

// Load .env
dotenv.config();

const app = express();
// Allow configurable JSON body size (large base64 images for /sessions/scan)
// Default increased from Express ~100kb to 4mb to fit ~3MB binary image (base64 expands ~33%).
const JSON_LIMIT = process.env.JSON_BODY_LIMIT || "4mb";
app.use(express.json({ limit: JSON_LIMIT }));

// Configure CORS with long preflight caching and multiple origins support
const rawCorsOrigins = (process.env.CORS_ORIGINS || "").trim();
const allowAllCors =
  rawCorsOrigins === "*" || process.env.ALLOW_ALL_CORS === "1";
const allowlist = rawCorsOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (allowAllCors) {
  // Temporary relaxed policy: allow all origins. Note: credentials must be false with '*'.
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
      credentials: false,
      maxAge: 86400,
    })
  );
  console.warn(
    "CORS is in permissive mode: allowing all origins (*) without credentials"
  );
} else {
  const corsSettings: cors.CorsOptions = {
    // IMPORTANT: with credentials: true we cannot send Access-Control-Allow-Origin: "*".
    // Use a function that reflects the request origin to work correctly with credentials.
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      // Allow requests without origin (e.g., Postman, curl)
      if (!origin) return callback(null, true);

      // In non-production allow all origins (reflecting origin)
      if (process.env.NODE_ENV !== "production") return callback(null, true);

      // In production – only those in the allowlist
      if (allowlist.includes(origin)) return callback(null, true);

      console.warn(`CORS blocked request from: ${origin}`);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true,
    maxAge: 86400, // 24h preflight caching (OPTIONS)
  };

  app.use(cors(corsSettings));
}

// ── Rate Limiters ─────────────────────────────────────────────────────────
// Global limiter: 120 req / min per IP (generous, just stops floods)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
  skip: () => process.env.NODE_ENV === "test",
});

// Auth limiter: 10 attempts / 15 min (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === "test",
});

// Receipt scan limiter: 5 req / min (Gemini API is expensive)
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Scan rate limit exceeded. Please wait a moment." },
  skip: () => process.env.NODE_ENV === "test",
});

app.use(globalLimiter);

// Serve locally uploaded files (avatar fallback when R2 is not configured)
app.use("/static", express.static(path.join(__dirname, "../../uploads")));

// Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Auth routes with logging + brute-force protection
app.use("/auth", logAuthAttempts, authLimiter, authRoutes);
app.use("/user", userRoutes);
app.use("/friends", friendsRoutes);
app.use("/groups", groupsRoutes);
// Apply tight limit to the expensive Gemini scan endpoint before the full sessions router
app.use("/sessions/scan", scanLimiter);
app.use("/sessions", sessionsRoutes);
app.use("/users", usersRoutes);
app.use("/uploads", uploadsRoutes);
app.use("/debug", debugRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Global error handler (must be after routes)
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(
    "CORS allowlist:",
    allowAllCors
      ? "* (permissive)"
      : allowlist.length
      ? allowlist
      : "(none / dev mode)"
  );
});

console.log("DEBUG ENV:", {
  PORT: process.env.PORT,
  DATABASE_URL: process.env.DATABASE_URL ? "OK" : "MISSING",
  JWT_SECRET: process.env.JWT_SECRET ? "OK" : "MISSING",
  JSON_BODY_LIMIT: JSON_LIMIT,
});
