import { Magic } from '@magic-sdk/admin';
import { getRepository } from 'typeorm';
import { CompanyUser, CompanyUserRole } from '../entity/company-user';
import { IncomingHttpHeaders } from 'http';
import dotenv from 'dotenv';
import { NextFunction } from 'express';

dotenv.config();

const magic = new Magic(process.env.MAGIC_SECRET || '');

const getTokenFromHeaders = (headers: IncomingHttpHeaders) => {
  const header = headers['x-access-token'];
  if (typeof header !== 'string') {
    throw new Error('No `Authorization` header present');
  }

  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) {
    throw new Error('Unsupported authorization type');
  }
  return token;
};

const checkCompanyUser = async (email: string) => {
  const repository = getRepository(CompanyUser);
  await repository.findOneOrFail({
    where: [
      { email, role: CompanyUserRole.Admin },
      { email, role: CompanyUserRole.SuperAdmin },
    ],
  });
};

const getEmailByToken = async (token: string) => {
  let meta;
  try {
    meta = await magic.users.getMetadataByToken(token);
  } catch {
    throw new Error('Failed to authenticate in Magic');
  }

  if (!meta.email) {
    throw new Error('Empty email');
  }
  return meta.email;
};

export const magicAuth = () => async (req: Request, res: Response, next: NextFunction) => {
  let token;
  try {
    token = getTokenFromHeaders(req.headers as any);
    magic.token.validate(token);
  } catch (e) {
    return next(e);
  }

  let email;
  try {
    email = await getEmailByToken(token);
  } catch (e) {
    return next(e);
  }

  try {
    await checkCompanyUser(email);
    next();
  } catch {
    next(new Error('Failed to authenticate'));
  }
};