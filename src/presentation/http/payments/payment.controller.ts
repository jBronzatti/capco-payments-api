import { Body, Controller, Get, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreatePaymentUseCase } from '../../../application/use-cases/create-payment.use-case';
import { GetPaymentUseCase } from '../../../application/use-cases/get-payment.use-case';
import { ListPaymentsUseCase } from '../../../application/use-cases/list-payments.use-case';
import { UpdatePaymentUseCase } from '../../../application/use-cases/update-payment.use-case';
import { UnauthorizedError } from '../auth/auth';
import { uuidParam } from '../validation';
import { CreatePaymentDto, ListPaymentsQueryDto, UpdatePaymentDto } from './payment.dto';
import {
  PaymentListResponse,
  PaymentResponse,
  presentPayment,
  presentPaymentList,
} from './payment.presenter';

@Controller('api/payment')
export class PaymentController {
  constructor(
    private readonly createPayment: CreatePaymentUseCase,
    private readonly getPayment: GetPaymentUseCase,
    private readonly listPayments: ListPaymentsUseCase,
    private readonly updatePayment: UpdatePaymentUseCase,
  ) {}

  @Post()
  async create(
    @Body() body: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentResponse> {
    const payment = await this.createPayment.execute(body);
    res.location(`/api/payment/${payment.id}`);
    return presentPayment(payment);
  }

  @Get()
  async list(@Query() query: ListPaymentsQueryDto): Promise<PaymentListResponse> {
    const listing = await this.listPayments.execute({
      ...(query.cpf !== undefined ? { cpf: query.cpf } : {}),
      ...(query.paymentMethod !== undefined ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      page: query.page,
      limit: query.limit,
    });
    return presentPaymentList(listing);
  }

  @Get(':id')
  async findOne(@Param('id', uuidParam('id')) id: string): Promise<PaymentResponse> {
    return presentPayment(await this.getPayment.execute(id));
  }

  @Put(':id')
  async update(
    @Param('id', uuidParam('id')) id: string,
    @Body() body: UpdatePaymentDto,
    @Req() request: Request,
  ): Promise<PaymentResponse> {
    const principal = request.principal;
    if (!principal) throw new UnauthorizedError('A valid API key is required');
    const payment = await this.updatePayment.execute({
      id,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      actor: { id: principal.keyId, canSettle: principal.canSettle },
    });
    return presentPayment(payment);
  }
}
