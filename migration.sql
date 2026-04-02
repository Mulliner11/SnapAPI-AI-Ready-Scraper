-- CreateTable
CREATE TABLE "login_sessions" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_sessions_token_hash_key" ON "login_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "login_sessions_email_idx" ON "login_sessions"("email");
