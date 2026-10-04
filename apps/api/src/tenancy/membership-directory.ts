import { Inject, Injectable } from "@nestjs/common";
import { type Database, eq, membershipDirectory, withUser } from "@zvenko/db";
import { DATABASE } from "../database/database.module.js";

/**
 * Компании пользователя — по справочнику platform.membership_directory, без чтения данных
 * компаний. RLS пускает только в строки пользователя из контекста.
 */
@Injectable()
export class MembershipDirectory {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** ID компаний, где пользователь работает сейчас, — по возрастанию. */
  async tenantsOf(userId: string): Promise<string[]> {
    const rows = await withUser(this.db, userId, (tx) =>
      tx
        .select({ tenantId: membershipDirectory.tenantId })
        .from(membershipDirectory)
        .where(eq(membershipDirectory.userId, userId)),
    );
    return rows.map((row) => row.tenantId).sort();
  }
}
