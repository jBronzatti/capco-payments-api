import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CreatePaymentUseCase } from '../../../application/use-cases/create-payment.use-case';
import { GetPaymentUseCase } from '../../../application/use-cases/get-payment.use-case';
import { uuidParam } from '../validation';
import { CreatePaymentDto } from './payment.dto';
import { PaymentResponse, presentPayment } from './payment.presenter';

@Controller('api/payment')
export class PaymentController {
  constructor(
    private readonly createPayment: CreatePaymentUseCase,
    private readonly getPayment: GetPaymentUseCase,
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

  @Get(':id')
  async findOne(@Param('id', uuidParam('id')) id: string): Promise<PaymentResponse> {
    return presentPayment(await this.getPayment.execute(id));
  }
}
