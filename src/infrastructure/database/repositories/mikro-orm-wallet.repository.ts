import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { IWalletRepository } from "../../../domain/repositories/wallet.repository.interface";
import { Wallet } from "../../../domain/models/wallet.aggregate";
import { WalletOrmEntity } from "../entities/wallet.orm-entity";

export class MikroOrmWalletRepository implements IWalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletOrmEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletOrmEntity, { playerId, currency });
    return entity ? this.toDomain(entity) : null;
  }

  async findForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(
      WalletOrmEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE }
    );
    return entity ? this.toDomain(entity) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    let entity = await this.em.findOne(WalletOrmEntity, { id: wallet.id });
    if (!entity) {
      entity = new WalletOrmEntity();
      entity.id = wallet.id;
      entity.playerId = wallet.playerId;
      entity.currency = wallet.currency;
      entity.createdAt = wallet.createdAt;
      this.em.persist(entity);
    }

    entity.balance = wallet.balance.amount;
    entity.version = wallet.version;
    entity.updatedAt = wallet.updatedAt;
  }

  private toDomain(entity: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: {
        amount: entity.balance,
        currency: entity.currency,
      },
      version: Number(entity.version),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }
}
