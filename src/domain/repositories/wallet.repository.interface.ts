import { Wallet } from "../models/wallet.aggregate";

export interface IWalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  findForUpdate(id: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}
