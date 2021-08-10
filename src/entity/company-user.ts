import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
  
  export enum CompanyUserRole {
    Client = 'client',
    Admin = 'admin',
    SuperAdmin = 'superadmin',
  }
  
@Entity({ name: 'company_users' })
export class CompanyUser {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ unique: true })
    email!: string;

    @Column({ type: 'enum', enum: CompanyUserRole })
    role!: CompanyUserRole;

    @Column({ type: 'text', nullable: true })
    companyName!: string | null;

    @CreateDateColumn({
    type: 'timestamp with time zone',
    default: () => 'CURRENT_TIMESTAMP',
    })
    createdAt!: Date;

    @UpdateDateColumn({
    type: 'timestamp with time zone',
    default: () => 'CURRENT_TIMESTAMP',
    })
    updatedAt!: Date;
}