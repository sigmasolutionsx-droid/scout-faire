const { users } = require("../shared/schema");
const { db } = require("./db");
const { eq, sql } = require("drizzle-orm");

const FREE_CREDITS_PER_MONTH = 5;

class DatabaseStorage {
  async getUser(id) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData) {
    const [user] = await db
      .insert(users)
      .values({
        ...userData,
        freeCreditsUsed: 0,
        freeCreditsRefreshedAt: new Date()
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: userData.email,
          firstName: userData.firstName,
          lastName: userData.lastName,
          profileImageUrl: userData.profileImageUrl,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  async addCredits(userId, amount) {
    let user = await this.getUser(userId);
    if (!user) {
      user = await this.upsertUser({ id: userId });
    }
    const [updated] = await db
      .update(users)
      .set({ 
        credits: sql`${users.credits} + ${amount}`,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();
    return updated;
  }

  checkMonthReset(user) {
    if (!user.freeCreditsRefreshedAt) return true;
    const now = new Date();
    const lastRefresh = new Date(user.freeCreditsRefreshedAt);
    return now.getMonth() !== lastRefresh.getMonth() || 
           now.getFullYear() !== lastRefresh.getFullYear();
  }

  async getFreeCreditsRemaining(userId) {
    const user = await this.getUser(userId);
    if (!user) return FREE_CREDITS_PER_MONTH;
    
    if (this.checkMonthReset(user)) {
      await db
        .update(users)
        .set({ 
          freeCreditsUsed: 0,
          freeCreditsRefreshedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));
      return FREE_CREDITS_PER_MONTH;
    }
    
    return Math.max(0, FREE_CREDITS_PER_MONTH - (user.freeCreditsUsed || 0));
  }

  async useCredit(userId) {
    let user = await this.getUser(userId);
    if (!user) return false;

    if (user.subscriptionType === 'pro' && 
        user.subscriptionExpiresAt && 
        user.subscriptionExpiresAt > new Date()) {
      return true;
    }

    if (user.subscriptionType === 'enterprise' && 
        user.subscriptionExpiresAt && 
        user.subscriptionExpiresAt > new Date()) {
      return true;
    }

    if (user.credits > 0) {
      await db
        .update(users)
        .set({ 
          credits: sql`${users.credits} - 1`,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));
      return true;
    }

    if (this.checkMonthReset(user)) {
      await db
        .update(users)
        .set({ 
          freeCreditsUsed: 1,
          freeCreditsRefreshedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));
      return true;
    }

    const freeRemaining = FREE_CREDITS_PER_MONTH - (user.freeCreditsUsed || 0);
    if (freeRemaining > 0) {
      await db
        .update(users)
        .set({ 
          freeCreditsUsed: sql`${users.freeCreditsUsed} + 1`,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));
      return true;
    }

    return false;
  }

  async setSubscription(userId, type, expiresAt) {
    let user = await this.getUser(userId);
    if (!user) {
      user = await this.upsertUser({ id: userId });
    }
    const [updated] = await db
      .update(users)
      .set({ 
        subscriptionType: type,
        subscriptionExpiresAt: expiresAt,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();
    return updated;
  }
}

const storage = new DatabaseStorage();

module.exports = { storage };
