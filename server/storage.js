const { users } = require("../shared/schema");
const { db } = require("./db");
const { eq, sql } = require("drizzle-orm");

class DatabaseStorage {
  async getUser(id) {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData) {
    const [user] = await db
      .insert(users)
      .values(userData)
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
    const [user] = await db
      .update(users)
      .set({ 
        credits: sql`${users.credits} + ${amount}`,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async useCredit(userId) {
    const user = await this.getUser(userId);
    if (!user) return false;

    if (user.subscriptionType === 'seikuku' && 
        user.subscriptionExpiresAt && 
        user.subscriptionExpiresAt > new Date()) {
      return true;
    }

    if (user.credits <= 0) return false;

    await db
      .update(users)
      .set({ 
        credits: sql`${users.credits} - 1`,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId));
    
    return true;
  }

  async setSubscription(userId, type, expiresAt) {
    const credits = type === 'pro' ? 30 : 0;
    const [user] = await db
      .update(users)
      .set({ 
        subscriptionType: type,
        subscriptionExpiresAt: expiresAt,
        credits: type === 'pro' ? credits : sql`${users.credits}`,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }
}

const storage = new DatabaseStorage();

module.exports = { storage };
